"""FastAPI server for WebXR passthrough character application."""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.model_loader import ensure_model, get_manifest, list_models, set_active_model

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("webxr")

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
CALIBRATION_DIR = DATA_DIR / "calibration"
MODELS_DIR = DATA_DIR / "models"
STATIC_DIR = Path(__file__).parent / "static"

CALIBRATION_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    manifest = ensure_model()
    logger.info("Model ready: %s", manifest.get("source"))
    yield


app = FastAPI(
    title="WebXR Passthrough Character",
    description="Local immersive AR character lab for Meta Quest",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CalibrationProfile(BaseModel):
    name: str = Field(default="default")
    offset: list[float] = Field(default_factory=lambda: [0.0, -0.2, 0.3])
    radius: float = 0.08
    height: float = 0.18
    created_at: float | None = None
    meta: dict[str, Any] = Field(default_factory=dict)


class TelemetryBatch(BaseModel):
    session_id: str | None = None
    events: list[dict[str, Any]] = Field(default_factory=list)


class ActiveModelRequest(BaseModel):
    id: str = Field(..., min_length=1, max_length=64)


class ConnectionManager:
    def __init__(self) -> None:
        self.active: dict[str, WebSocket] = {}

    async def connect(self, websocket: WebSocket) -> str:
        await websocket.accept()
        client_id = str(uuid.uuid4())
        self.active[client_id] = websocket
        logger.info("WS connected %s (%d clients)", client_id, len(self.active))
        return client_id

    def disconnect(self, client_id: str) -> None:
        self.active.pop(client_id, None)
        logger.info("WS disconnected %s (%d clients)", client_id, len(self.active))

    async def broadcast(self, message: dict[str, Any], exclude: str | None = None) -> None:
        dead: list[str] = []
        payload = json.dumps(message)
        for cid, ws in self.active.items():
            if cid == exclude:
                continue
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(cid)
        for cid in dead:
            self.disconnect(cid)


manager = ConnectionManager()


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health() -> dict[str, Any]:
    manifest = get_manifest()
    return {
        "status": "ok",
        "model": manifest,
        "clients": len(manager.active),
        "time": time.time(),
    }


@app.get("/api/model")
async def api_model() -> dict[str, Any]:
    return get_manifest()


@app.get("/api/models")
async def api_models() -> dict[str, Any]:
    return list_models()


@app.post("/api/model/active")
async def api_set_active_model(body: ActiveModelRequest) -> JSONResponse:
    try:
        manifest = set_active_model(body.id)
    except KeyError:
        return JSONResponse({"error": f"unknown model id: {body.id}"}, status_code=404)
    except FileNotFoundError as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)
    await manager.broadcast({"type": "model_changed", "model": manifest})
    return JSONResponse(manifest)


@app.get("/api/calibration")
async def list_calibration() -> dict[str, Any]:
    profiles = []
    for path in sorted(CALIBRATION_DIR.glob("*.json")):
        try:
            profiles.append(json.loads(path.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            continue
    return {"profiles": profiles}


@app.get("/api/calibration/{name}")
async def get_calibration(name: str) -> JSONResponse:
    path = CALIBRATION_DIR / f"{name}.json"
    if not path.exists():
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse(json.loads(path.read_text(encoding="utf-8")))


@app.post("/api/calibration")
async def save_calibration(profile: CalibrationProfile) -> dict[str, Any]:
    safe = "".join(c for c in profile.name if c.isalnum() or c in "-_") or "default"
    payload = profile.model_dump()
    payload["name"] = safe
    payload["created_at"] = time.time()
    path = CALIBRATION_DIR / f"{safe}.json"
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    await manager.broadcast({"type": "calibration_saved", "profile": payload})
    return payload


@app.delete("/api/calibration/{name}")
async def delete_calibration(name: str) -> dict[str, Any]:
    safe = "".join(c for c in name if c.isalnum() or c in "-_") or "default"
    path = CALIBRATION_DIR / f"{safe}.json"
    if path.exists():
        path.unlink()
    return {"deleted": safe}


@app.post("/api/telemetry")
async def post_telemetry(batch: TelemetryBatch) -> dict[str, str]:
    # Persist last batch for debugging; keep file small
    out = DATA_DIR / "last_telemetry.json"
    out.write_text(
        json.dumps(
            {
                "received_at": time.time(),
                "session_id": batch.session_id,
                "count": len(batch.events),
                "events": batch.events[-50:],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return {"status": "ok"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    client_id = await manager.connect(websocket)
    await websocket.send_json(
        {
            "type": "welcome",
            "client_id": client_id,
            "model": get_manifest(),
            "server_time": time.time(),
        }
    )
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "message": "invalid json"})
                continue

            msg_type = msg.get("type")
            if msg_type == "ping":
                await websocket.send_json({"type": "pong", "t": time.time()})
            elif msg_type in {"telemetry", "interaction", "calibration"}:
                enriched = {
                    **msg,
                    "client_id": client_id,
                    "server_time": time.time(),
                }
                # Echo ack + optional broadcast for multi-client sync
                await websocket.send_json({"type": "ack", "of": msg_type})
                if msg.get("broadcast"):
                    await manager.broadcast(enriched, exclude=client_id)
            elif msg_type == "get_model":
                await websocket.send_json({"type": "model", "model": get_manifest()})
            else:
                await websocket.send_json(
                    {"type": "error", "message": f"unknown type: {msg_type}"}
                )
    except WebSocketDisconnect:
        manager.disconnect(client_id)


mimetypes.add_type("model/gltf-binary", ".glb")
mimetypes.add_type("model/gltf+json", ".gltf")

# Static assets (CSS/JS) and persistent model volume
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/assets/models", StaticFiles(directory=MODELS_DIR), name="models")

"""Download textured / clay female GLBs and keep a dual-model catalog."""

from __future__ import annotations

import json
import logging
import os
import shutil
import struct
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

logger = logging.getLogger("model_loader")

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
MODELS_DIR = DATA_DIR / "models"
MODEL_PATH = MODELS_DIR / "character.glb"
MANIFEST_PATH = MODELS_DIR / "manifest.json"
CATALOG_PATH = MODELS_DIR / "catalog.json"

# Bundled offline seed (textured casual female) shipped with the image
BUNDLED_FALLBACK = Path(__file__).parent / "static" / "models" / "fallback-character.glb"

DEFAULT_ACTIVE_ID = "casual-woman"

# Dual catalog: textured Grab3D default + MakeHuman clay base with soft bones
MODEL_CATALOG: dict[str, dict[str, Any]] = {
    "casual-woman": {
        "id": "casual-woman",
        "label": "Casual Woman",
        "gender": "female",
        "license": "CC0",
        "filename": "casual-woman.glb",
        "download_url": "https://grab3d.com/dl/woman-rigged/woman-rigged.glb",
        "fallback_urls": [
            "https://grab3d.com/dl/woman/woman-light.glb",
            "https://www.innerscene.com/api/library/"
            "low-poly-character-casual-female-t-pose-rigged-e3f33b11/download",
        ],
        "soft_bones": [
            "Spine02",
            "Spine01",
            "Hips",
            "LeftUpLeg",
            "RightUpLeg",
        ],
        "polish": "textured",
        "default": True,
    },
    "female-base": {
        "id": "female-base",
        "label": "Female Base",
        "gender": "female",
        "license": "CC0",
        "filename": "female-base.glb",
        "download_url": (
            "https://www.innerscene.com/api/library/"
            "female-base-mesh-3d-person-rigged-a-pose-dba97ed5/download"
        ),
        "fallback_urls": [
            "https://www.innerscene.com/api/library/"
            "low-poly-character-casual-female-t-pose-rigged-e3f33b11/download",
        ],
        "soft_bones": [
            "breast.L",
            "breast.R",
            "spine02",
            "spine04",
            "root",
            "upperleg01.L",
            "upperleg01.R",
        ],
        "polish": "clay",
        "default": False,
    },
}


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _write_manifest(payload: dict[str, Any]) -> None:
    _write_json(MANIFEST_PATH, payload)


def _download(url: str, dest: Path, timeout: float = 120.0) -> None:
    req = Request(url, headers={"User-Agent": "webxr-passthrough/1.0"})
    with urlopen(req, timeout=timeout) as resp:
        data = resp.read()
    if len(data) < 12 or data[:4] != b"glTF":
        raise ValueError(f"Downloaded content is not a valid GLB: {url}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)


def _pack_gltf_json(gltf: dict[str, Any]) -> bytes:
    raw = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    pad = (4 - (len(raw) % 4)) % 4
    return raw + (b" " * pad)


def _build_procedural_glb() -> bytes:
    """
    Build a minimal valid GLB with a simple humanoid mesh and bone hierarchy.
    Used when remote download fails so the runtime never crashes.
    """
    positions: list[float] = []
    normals: list[float] = []
    indices: list[int] = []
    joints: list[int] = []
    weights: list[float] = []

    def add_box(
        cx: float,
        cy: float,
        cz: float,
        sx: float,
        sy: float,
        sz: float,
        bone: int,
    ) -> None:
        base = len(positions) // 3
        hx, hy, hz = sx * 0.5, sy * 0.5, sz * 0.5
        corners = [
            (cx - hx, cy - hy, cz - hz),
            (cx + hx, cy - hy, cz - hz),
            (cx + hx, cy + hy, cz - hz),
            (cx - hx, cy + hy, cz - hz),
            (cx - hx, cy - hy, cz + hz),
            (cx + hx, cy - hy, cz + hz),
            (cx + hx, cy + hy, cz + hz),
            (cx - hx, cy + hy, cz + hz),
        ]
        for x, y, z in corners:
            positions.extend([x, y, z])
            nx = 0.0 if abs(x - cx) < 1e-6 else (1.0 if x > cx else -1.0)
            ny = 0.0 if abs(y - cy) < 1e-6 else (1.0 if y > cy else -1.0)
            nz = 0.0 if abs(z - cz) < 1e-6 else (1.0 if z > cz else -1.0)
            length = (nx * nx + ny * ny + nz * nz) ** 0.5 or 1.0
            normals.extend([nx / length, ny / length, nz / length])
            joints.extend([bone, 0, 0, 0])
            weights.extend([1.0, 0.0, 0.0, 0.0])

        faces = [
            (0, 1, 2, 3),
            (4, 7, 6, 5),
            (0, 4, 5, 1),
            (2, 6, 7, 3),
            (0, 3, 7, 4),
            (1, 5, 6, 2),
        ]
        for a, b, c, d in faces:
            indices.extend([base + a, base + b, base + c, base + a, base + c, base + d])

    # Female proportions (narrower shoulders, wider hips, soft clusters)
    add_box(0.0, 0.95, 0.0, 0.34, 0.18, 0.20, 0)  # hips
    add_box(0.0, 1.15, 0.0, 0.24, 0.22, 0.14, 1)  # spine / torso
    add_box(0.0, 1.36, 0.04, 0.28, 0.22, 0.16, 2)  # chest
    add_box(0.0, 1.56, 0.0, 0.09, 0.10, 0.09, 3)  # neck
    add_box(0.0, 1.70, 0.0, 0.17, 0.19, 0.17, 4)  # head
    add_box(-0.11, 0.64, 0.0, 0.13, 0.36, 0.13, 5)  # L upleg
    add_box(-0.11, 0.28, 0.0, 0.10, 0.34, 0.10, 6)  # L leg
    add_box(0.11, 0.64, 0.0, 0.13, 0.36, 0.13, 7)  # R upleg
    add_box(0.11, 0.28, 0.0, 0.10, 0.34, 0.10, 8)  # R leg
    add_box(-0.24, 1.38, 0.0, 0.18, 0.07, 0.07, 9)  # L shoulder
    add_box(-0.38, 1.18, 0.0, 0.07, 0.30, 0.07, 10)  # L arm
    add_box(0.24, 1.38, 0.0, 0.18, 0.07, 0.07, 11)  # R shoulder
    add_box(0.38, 1.18, 0.0, 0.07, 0.30, 0.07, 12)  # R arm
    add_box(-0.10, 1.34, 0.12, 0.14, 0.13, 0.13, 13)  # breast L soft
    add_box(0.10, 1.34, 0.12, 0.14, 0.13, 0.13, 14)  # breast R soft
    add_box(-0.10, 0.92, -0.10, 0.14, 0.14, 0.12, 15)  # glute L soft
    add_box(0.10, 0.92, -0.10, 0.14, 0.14, 0.12, 16)  # glute R soft

    pos_bytes = struct.pack(f"<{len(positions)}f", *positions)
    nrm_bytes = struct.pack(f"<{len(normals)}f", *normals)
    idx_bytes = struct.pack(f"<{len(indices)}H", *indices)
    jnt_bytes = struct.pack(f"<{len(joints)}H", *joints)
    wgt_bytes = struct.pack(f"<{len(weights)}f", *weights)

    bone_count = 17
    ibm = []
    for _ in range(bone_count):
        ibm.extend([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    ibm_bytes = struct.pack(f"<{len(ibm)}f", *ibm)

    bin_blob = bytearray()
    offsets: dict[str, tuple[int, int]] = {}

    def append_buf(name: str, data: bytes, align: int = 4) -> None:
        pad = (align - (len(bin_blob) % align)) % align
        bin_blob.extend(b"\x00" * pad)
        start = len(bin_blob)
        bin_blob.extend(data)
        offsets[name] = (start, len(data))

    append_buf("pos", pos_bytes)
    append_buf("nrm", nrm_bytes)
    append_buf("idx", idx_bytes)
    append_buf("jnt", jnt_bytes)
    append_buf("wgt", wgt_bytes)
    append_buf("ibm", ibm_bytes)
    pad = (4 - (len(bin_blob) % 4)) % 4
    bin_blob.extend(b"\x00" * pad)

    bone_defs = [
        ("Hips", None, [0, 0.95, 0]),
        ("Spine", "Hips", [0, 0.20, 0]),
        ("Chest", "Spine", [0, 0.23, 0.02]),
        ("Neck", "Chest", [0, 0.20, -0.02]),
        ("Head", "Neck", [0, 0.14, 0]),
        ("LeftUpLeg", "Hips", [-0.11, -0.05, 0]),
        ("LeftLeg", "LeftUpLeg", [0, -0.36, 0]),
        ("RightUpLeg", "Hips", [0.11, -0.05, 0]),
        ("RightLeg", "RightUpLeg", [0, -0.36, 0]),
        ("LeftShoulder", "Chest", [-0.12, 0.08, 0]),
        ("LeftArm", "LeftShoulder", [-0.12, -0.08, 0]),
        ("RightShoulder", "Chest", [0.12, 0.08, 0]),
        ("RightArm", "RightShoulder", [0.12, -0.08, 0]),
        ("BreastL", "Chest", [-0.10, -0.02, 0.12]),
        ("BreastR", "Chest", [0.10, -0.02, 0.12]),
        ("GluteL", "Hips", [-0.10, -0.03, -0.10]),
        ("GluteR", "Hips", [0.10, -0.03, -0.10]),
    ]
    name_to_index = {n: i for i, (n, _, _) in enumerate(bone_defs)}

    nodes = []
    for name, parent, translation in bone_defs:
        node: dict[str, Any] = {"name": name, "translation": translation}
        children = [name_to_index[child] for child, p, _ in bone_defs if p == name]
        if children:
            node["children"] = children
        nodes.append(node)

    mesh_node_index = len(nodes)
    nodes.append({"name": "HumanoidMesh", "mesh": 0, "skin": 0})

    accessors = [
        {
            "bufferView": 0,
            "componentType": 5126,
            "count": len(positions) // 3,
            "type": "VEC3",
            "max": [
                max(positions[0::3]),
                max(positions[1::3]),
                max(positions[2::3]),
            ],
            "min": [
                min(positions[0::3]),
                min(positions[1::3]),
                min(positions[2::3]),
            ],
        },
        {
            "bufferView": 1,
            "componentType": 5126,
            "count": len(normals) // 3,
            "type": "VEC3",
        },
        {
            "bufferView": 2,
            "componentType": 5123,
            "count": len(indices),
            "type": "SCALAR",
        },
        {
            "bufferView": 3,
            "componentType": 5123,
            "count": len(joints) // 4,
            "type": "VEC4",
        },
        {
            "bufferView": 4,
            "componentType": 5126,
            "count": len(weights) // 4,
            "type": "VEC4",
        },
        {
            "bufferView": 5,
            "componentType": 5126,
            "count": bone_count,
            "type": "MAT4",
        },
    ]

    buffer_views = [
        {"buffer": 0, "byteOffset": offsets["pos"][0], "byteLength": offsets["pos"][1], "target": 34962},
        {"buffer": 0, "byteOffset": offsets["nrm"][0], "byteLength": offsets["nrm"][1], "target": 34962},
        {"buffer": 0, "byteOffset": offsets["idx"][0], "byteLength": offsets["idx"][1], "target": 34963},
        {"buffer": 0, "byteOffset": offsets["jnt"][0], "byteLength": offsets["jnt"][1], "target": 34962},
        {"buffer": 0, "byteOffset": offsets["wgt"][0], "byteLength": offsets["wgt"][1], "target": 34962},
        {"buffer": 0, "byteOffset": offsets["ibm"][0], "byteLength": offsets["ibm"][1]},
    ]

    gltf = {
        "asset": {"version": "2.0", "generator": "webxr-passthrough-fallback"},
        "scenes": [{"nodes": [0, mesh_node_index]}],
        "scene": 0,
        "nodes": nodes,
        "meshes": [
            {
                "name": "ProceduralHumanoid",
                "primitives": [
                    {
                        "attributes": {
                            "POSITION": 0,
                            "NORMAL": 1,
                            "JOINTS_0": 3,
                            "WEIGHTS_0": 4,
                        },
                        "indices": 2,
                        "material": 0,
                    }
                ],
            }
        ],
        "skins": [
            {
                "name": "HumanoidSkin",
                "joints": list(range(bone_count)),
                "inverseBindMatrices": 5,
                "skeleton": 0,
            }
        ],
        "materials": [
            {
                "name": "SkinTone",
                "pbrMetallicRoughness": {
                    "baseColorFactor": [0.90, 0.70, 0.60, 1.0],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.62,
                },
                "doubleSided": True,
            }
        ],
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(bin_blob)}],
    }

    json_chunk = _pack_gltf_json(gltf)
    bin_chunk = bytes(bin_blob)

    total_len = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    header = struct.pack("<4sII", b"glTF", 2, total_len)
    json_header = struct.pack("<II", len(json_chunk), 0x4E4F534A)  # JSON
    bin_header = struct.pack("<II", len(bin_chunk), 0x004E4942)  # BIN

    return header + json_header + json_chunk + bin_header + bin_chunk


def _model_file(entry: dict[str, Any]) -> Path:
    return MODELS_DIR / entry["filename"]


def _public_url(entry: dict[str, Any]) -> str:
    return f"/assets/models/{entry['filename']}"


def _read_catalog_state() -> dict[str, Any]:
    if CATALOG_PATH.exists():
        try:
            return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {"active_model_id": DEFAULT_ACTIVE_ID, "models": {}}


def _write_catalog_state(state: dict[str, Any]) -> None:
    _write_json(CATALOG_PATH, state)


def _entry_manifest(
    entry: dict[str, Any],
    *,
    source: str,
    procedural: bool = False,
    download_url: str | None = None,
    error: str | None = None,
    active: bool = False,
) -> dict[str, Any]:
    path = _model_file(entry)
    payload: dict[str, Any] = {
        "id": entry["id"],
        "model_id": entry["id"],
        "label": entry["label"],
        "gender": entry["gender"],
        "license": entry.get("license", "unknown"),
        "source": source,
        "path": str(path),
        "url": _public_url(entry),
        "procedural": procedural,
        "bytes": path.stat().st_size if path.exists() else 0,
        "soft_bones": list(entry.get("soft_bones") or []),
        "polish": entry.get("polish", "textured"),
        "ready": path.exists() and path.stat().st_size > 12,
        "active": active,
    }
    if download_url:
        payload["download_url"] = download_url
    if error:
        payload["error"] = error
    return payload


def _install_bundled_for(entry: dict[str, Any]) -> dict[str, Any] | None:
    if not BUNDLED_FALLBACK.exists() or BUNDLED_FALLBACK.stat().st_size < 12:
        return None
    dest = _model_file(entry)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(BUNDLED_FALLBACK, dest)
    return _entry_manifest(entry, source="bundled", procedural=False)


def _write_procedural_for(entry: dict[str, Any], error: str | None = None) -> dict[str, Any]:
    dest = _model_file(entry)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(_build_procedural_glb())
    return _entry_manifest(
        entry,
        source="procedural",
        procedural=True,
        error=error,
    )


def _ensure_single_model(entry: dict[str, Any], force: bool = False) -> dict[str, Any]:
    dest = _model_file(entry)
    if not force and dest.exists() and dest.stat().st_size > 12:
        logger.info("Using cached model %s (%s bytes)", entry["id"], dest.stat().st_size)
        return _entry_manifest(entry, source="cache")

    primary = entry["download_url"]
    # Allow env override only for the default textured model
    if entry["id"] == DEFAULT_ACTIVE_ID:
        primary = os.environ.get("MODEL_URL", primary)
    candidates = [primary, *[u for u in entry.get("fallback_urls", []) if u != primary]]
    last_error: Exception | None = None

    for url in candidates:
        try:
            logger.info("Downloading %s from %s", entry["id"], url)
            _download(url, dest)
            return _entry_manifest(
                entry,
                source="remote",
                download_url=url,
            )
        except (URLError, TimeoutError, ValueError, OSError) as exc:
            last_error = exc
            logger.warning("Download failed for %s (%s): %s", entry["id"], url, exc)

    # Prefer bundled seed for textured default; procedural for clay base
    if entry["id"] == DEFAULT_ACTIVE_ID:
        bundled = _install_bundled_for(entry)
        if bundled is not None:
            bundled["error"] = str(last_error) if last_error else "download failed"
            return bundled

    return _write_procedural_for(
        entry,
        error=str(last_error) if last_error else "download failed",
    )


def _publish_active(active_id: str, models: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Copy active file to character.glb and write active manifest."""
    if active_id not in models:
        active_id = next(iter(models), DEFAULT_ACTIVE_ID)
    entry = MODEL_CATALOG[active_id]
    src = _model_file(entry)
    if not src.exists():
        raise FileNotFoundError(f"Active model file missing: {src}")

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, MODEL_PATH)

    active = dict(models[active_id])
    active["active"] = True
    active["active_model_id"] = active_id
    # Keep legacy character.glb URL as alias for the active model
    active["character_url"] = "/assets/models/character.glb"
    _write_manifest(active)
    _write_catalog_state({"active_model_id": active_id, "models": models})
    return active


def ensure_model() -> dict[str, Any]:
    """Ensure both catalog models exist; publish the active one as character.glb."""
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    state = _read_catalog_state()
    active_id = state.get("active_model_id") or DEFAULT_ACTIVE_ID
    if active_id not in MODEL_CATALOG:
        active_id = DEFAULT_ACTIVE_ID

    # Migrate legacy character.glb into casual-woman if needed
    casual_path = _model_file(MODEL_CATALOG["casual-woman"])
    if (
        not casual_path.exists()
        and MODEL_PATH.exists()
        and MODEL_PATH.stat().st_size > 12
    ):
        try:
            manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8")) if MANIFEST_PATH.exists() else {}
        except json.JSONDecodeError:
            manifest = {}
        if "female-base" not in str(manifest.get("model_id", "")):
            shutil.copyfile(MODEL_PATH, casual_path)
            logger.info("Migrated legacy character.glb → casual-woman.glb")

    models: dict[str, dict[str, Any]] = {}
    for mid, entry in MODEL_CATALOG.items():
        models[mid] = _ensure_single_model(entry)

    return _publish_active(active_id, models)


def list_models() -> dict[str, Any]:
    state = _read_catalog_state()
    active_id = state.get("active_model_id") or DEFAULT_ACTIVE_ID
    items = []
    for mid, entry in MODEL_CATALOG.items():
        path = _model_file(entry)
        cached = (state.get("models") or {}).get(mid) or {}
        ready = path.exists() and path.stat().st_size > 12
        items.append(
            {
                "id": mid,
                "label": entry["label"],
                "url": _public_url(entry),
                "gender": entry["gender"],
                "license": entry.get("license"),
                "soft_bones": list(entry.get("soft_bones") or []),
                "polish": entry.get("polish"),
                "ready": ready,
                "active": mid == active_id,
                "bytes": path.stat().st_size if ready else cached.get("bytes", 0),
                "procedural": bool(cached.get("procedural")),
                "source": cached.get("source"),
            }
        )
    return {"active_model_id": active_id, "models": items}


def set_active_model(model_id: str) -> dict[str, Any]:
    if model_id not in MODEL_CATALOG:
        raise KeyError(f"Unknown model id: {model_id}")
    entry = MODEL_CATALOG[model_id]
    info = _ensure_single_model(entry)
    state = _read_catalog_state()
    models = dict(state.get("models") or {})
    # Refresh entries we know about
    for mid, cat in MODEL_CATALOG.items():
        if mid == model_id:
            models[mid] = info
        elif mid not in models:
            models[mid] = _entry_manifest(cat, source="cache" if _model_file(cat).exists() else "missing")
        else:
            models[mid] = _entry_manifest(
                cat,
                source=models[mid].get("source", "cache"),
                procedural=bool(models[mid].get("procedural")),
                download_url=models[mid].get("download_url"),
            )
            models[mid]["active"] = False
    return _publish_active(model_id, models)


def get_manifest() -> dict[str, Any]:
    if MANIFEST_PATH.exists():
        try:
            data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
            if "id" not in data and data.get("model_id"):
                data["id"] = data["model_id"]
            if "active_model_id" not in data and data.get("id"):
                data["active_model_id"] = data["id"]
            return data
        except json.JSONDecodeError:
            pass
    return ensure_model()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(json.dumps(ensure_model(), indent=2))
    print(json.dumps(list_models(), indent=2))

# WebXR Passthrough Character

Lokale, produktionsfähige 3D-WebXR-Anwendung für **Meta Quest 2 / 3 / Pro** mit immersivem Passthrough (AR), Cannon-Physik, Soft-Body-Sekundärbewegung und Dual-Controller-Interaktion.

## Schnellstart

```bash
docker compose up --build
```

Optional die LAN-IP des Hosts setzen, damit das selbstsignierte Zertifikat sie enthält (empfohlen für Quest):

```bash
# Windows PowerShell
$env:HOST_IP="192.168.1.42"; docker compose up --build

# Linux / macOS
HOST_IP=192.168.1.42 docker compose up --build
```

Anschließend im Browser (PC oder Quest):

```text
https://<DEINE-LAN-IP>:8000
```

Das selbstsignierte Zertifikat muss im Quest-Browser einmalig akzeptiert werden (Zertifikatswarnung → Erweitert → fortfahren). WebXR erfordert HTTPS. Zertifikate liegen persistent unter `./certs`.

## Features

| Bereich | Umsetzung |
|--------|-----------|
| Backend | FastAPI + WebSocket (`/ws`), HTTPS via OpenSSL im Container-Start |
| Assets | GLB-Download (CC0 textured Casual Woman, Grab3D, rigged) → Volume `./data`; bundled textured seed + prozedurales Fallback |
| Frontend | Three.js + cannon-es lokal unter `/static/vendor` (kein externes CDN nötig) |
| WebXR | `immersive-ar`, `local-floor`, optional `hand-tracking`, transparentes Canvas (Passthrough) |
| Interaktion | Raycaster-Grab, Zwei-Hand-Skalierung, Rotation, Haptik, Desktop-Maus-Fallback |
| Physik | cannon-es Soft-Body A: Torso/Brust L+R/Becken/Glute L+R/Oberschenkel (Frauen-Tuning) |
| Kalibrierung | Controller-Offset zum HMD → kinematische Kollisionskapsel + Verdrängung/Haptik |
| Posen | Stehend, Liegend, Kniend, Rückenlage, Sitzend — VR-Dashboard oder B/Y |

## Steuerung

**Quest**

- **Trigger** — Charakter greifen / loslassen  
- **Grip (beide)** — skalieren  
- **A / X** — Kalibrierungs-Sonde am Controller setzen  
- **B / Y** — nächste Pose  

**Desktop**

- Linke Maustaste ziehen — Orbit  
- Scroll — Zoom  
- Rechte Maustaste — greifen / positionieren  

## Projektstruktur

```text
├── docker-compose.yml
├── Dockerfile
├── requirements.txt
├── entrypoint.sh
├── app/
│   ├── main.py
│   ├── model_loader.py
│   └── static/
│       ├── index.html
│       ├── css/style.css
│       └── js/
│           ├── app.js
│           ├── xr_manager.js
│           ├── physics.js
│           └── ui.js
├── data/                 # persistent (Modelle, Kalibrierung)
├── certs/                # persistent (selbstsigniertes SSL)
└── README.md
```

## API

- `GET /health` — Status + Modell-Manifest  
- `GET /api/model` — Modell-URL / Quelle  
- `GET|POST /api/calibration` — Kalibrierungsprofile  
- `WS /ws` — Telemetrie, Interaktion, Kalibrierung (`type`: `telemetry` \| `interaction` \| `calibration` \| `ping`)  

## Self-Hosting auf dem Server

```bash
git clone https://github.com/L8teNever/webxr-passthrough-character.git
cd webxr-passthrough-character
# optional: öffentliche IP / Domain fürs Zertifikat
export HOST_IP=203.0.113.10
# optional: anderes GLB
# export MODEL_URL=https://example.com/character.glb
docker compose up --build -d
```

Daten (`./data`) und Zertifikate (`./certs`) bleiben als Volumes persistent. Port **8000/TCP** in der Firewall freigeben. Beim ersten Start wird das texturierte Charakter-Modell (~13 MB) heruntergeladen; ohne Netz greift der mitgelieferte Seed unter `app/static/models/fallback-character.glb`.

## Hinweise Quest

1. PC und Headset im selben WLAN.  
2. Firewall: Port **8000/TCP** freigeben.  
3. IP des Hosts ermitteln (`ipconfig` / `hostname -I`) und als `HOST_IP` setzen (siehe oben).  
4. Quest Browser → `https://IP:8000` → Zertifikat akzeptieren → **AR starten**.  

Passthrough erscheint nur in einer echten `immersive-ar`-Session auf dem Headset; Desktop zeigt die Szene mit transparentem Hintergrund über dem UI.

## Charakter-Modell

Standard ist die **CC0 Casual Woman (rigged)** von Grab3D — texturiert (PBR), Kleidung, Haare, fertiger Look. Das frühere untexturierte MakeHuman-Clay-Mesh (inkl. High-Poly-Overlay / Z-Fighting an Brust & Kopf) wurde ersetzt. Soft-Body-Cluster greifen auf Spine/Hips/Beine zu; fehlende Soft-Bones werden synthetisch ergänzt.

## Lokaler Dev-Start (ohne Docker)

```bash
# Windows PowerShell — DATA_DIR auf ./data setzen
$env:DATA_DIR="$PWD\data"
python -c "from app.model_loader import ensure_model; print(ensure_model())"
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Für WebXR auf dem Headset weiterhin HTTPS nötig (Docker-Pfad empfohlen).

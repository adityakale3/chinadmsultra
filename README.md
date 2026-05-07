# DMS Server (JT808 / ULV / Starkenn)

Node.js receiver for Chinese DMS terminals using the **JT/T 808** signaling protocol with the **ULV (JT/T 1078)** alarm-attachment extension. Runs three TCP listeners + one HTTP API.

## Ports (configure these in your AWS security group)

| Service | Default port | Protocol | Direction |
|---|---|---|---|
| **JT808 / CMS data (device → server)** | **7611** | TCP | inbound |
| **Alarm attachment (video evidence) upload** | **7612** | TCP | inbound |
| **FTP control** | **21** | TCP | inbound |
| **FTP passive data** | **30000–30100** | TCP | inbound |
| HTTP REST API | 3000 | TCP | inbound |

> Override any of these with env vars: `JT808_PORT`, `ATTACHMENT_PORT`, `FTP_PORT`, `HTTP_PORT`, `PUBLIC_IP`.

## Run

```bash
cd dms-server
npm install
sudo PUBLIC_IP=13.206.186.1 npm start    # sudo only because FTP uses port 21
```

(For a non-root run, set `FTP_PORT=2121` and forward 21→2121 in the SG / iptables.)

## Endpoints

- `GET /messages` — every parsed JT808 frame (raw hex + parsed body)
- `GET /alerts` — only alarm/ADAS/DSM/BSD/multimedia events
- `GET /media` — index of saved files + disk listing
- `GET /media/:filename` — download a file
- `GET /terminals` — known terminals and last-seen times

## Device-side configuration

Point the terminal at the EC2 IP and JT808 TCP port:

- Server IP / domain: `13.206.186.1`
- TCP port: `7611`
- (Attachment server is auto-advertised inside the `0x9208` command — no manual setup on the device)

## What it implements

- JT808 framing: `0x7e` start/end, escape `0x7e/0x7d`, XOR checksum
- Header parsing for both 2013 (6-BCD phone) and 2019 (10-BCD phone, version byte) variants
- Handles: `0x0100` register → `0x8100`, `0x0102` auth, `0x0002` heartbeat, `0x0200` location, `0x0704` bulk locations, `0x0800/0x0801/0x0805` legacy multimedia. All others get `0x8001` general response.
- `0x0200` extras: standard fields + ULV `0x14` video-alarm bitfield, `0x64` ADAS, `0x65` DSM, `0x66` BSD with event-type decoding and 16-byte alarm-identification parsing.
- Auto-requests video evidence for every ADAS/DSM/BSD alarm via `0x9208`.
- Attachment server (`0x1210` / `0x1211` / bitstream `0x30 0x31 0x63 0x64` packets / `0x1212` → `0x9212`) saves files to `./media/`.
- Embedded FTP for `0x9206` file-upload flows; uploaded files are mirrored into `./media/`.

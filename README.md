# Trackline: real-time order tracking and live support

CSC337 Lab 04. One Express server exposes REST, JSON-RPC 2.0, SSE and Socket.io. A static frontend (Customer and Support agent views) talks to all four.

- **Frontend:** `https://YOUR-FRONTEND.vercel.app`
- **Backend:** `https://YOUR-BACKEND.onrender.com`

## Run locally

```bash
cd backend && npm install && npm start      # http://localhost:4000
cd frontend && npx serve .                  # any static server works
```

Open the frontend in two tabs: one as **Customer**, one as **Support agent**. The API URL switches to `localhost:4000` automatically.

| Env variable (backend) | Purpose |
| --- | --- |
| `PORT` | Set by Render/Railway |
| `CLIENT_ORIGIN` | Frontend URL for CORS, comma-separated. Defaults to `*` |

## Deploy

1. **Backend (Render):** New Web Service, root directory `backend`, build `npm install`, start `npm start`. Add `CLIENT_ORIGIN` once the frontend URL exists.
2. **Frontend (Vercel/Netlify):** root directory `frontend`, no build step. Put the Render URL in the `API` constant near the top of the script in `frontend/index.html`.

## Endpoints

| Protocol | Route | Purpose |
| --- | --- | --- |
| REST | `GET /api/v1/catalog` | Product list |
| REST | `GET /api/v1/orders` (`?status=`), `GET /api/v1/orders/:id` | List and read orders |
| REST | `POST /api/v1/orders` | Create order: `{ customerName, items: [{ sku, qty }] }` |
| REST | `PATCH /api/v1/orders/:id/status` | Agent moves order forward: `{ status }` |
| JSON-RPC 2.0 | `POST /rpc` | `cancelOrder`, `getOrderStatus`, `listMethods`. Supports batches and notifications |
| SSE | `GET /events` | Named event `alert`: `{ level, message, at }`. Heartbeat every 25 s |

RPC error codes: `-32700` parse, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32001` order not found, `-32002` order can't be cancelled.

## WebSocket events (Socket.io)

Order statuses: `placed → confirmed → packed → out_for_delivery → delivered`, or `cancelled` (only before dispatch).

| Event | Direction | Payload |
| --- | --- | --- |
| `agent_join` / `agent_leave` | client → server | none. Agents receive every order event |
| `join_order_room` | client → server | `{ orderId, role: "customer" \| "agent", name }`, ack `{ ok }` |
| `leave_order_room` | client → server | none |
| `chat_message` | client → server | `{ text }` |
| `chat_message` | server → room | `{ orderId, role, name, text, at }` (role `system` for status notes) |
| `chat_history` | server → joiner | `{ orderId, messages[] }` |
| `presence` | server → room | `{ orderId, customer, agent }` |
| `order_status_update` | server → order room and agents | full order object |
| `order_created` | server → agents | full order object |
| `room_replaced` | server → old socket | `{ orderId }`, sent when the same role joins from another tab |

Each order room `order:<id>` holds one customer and one agent (1-on-1 chat).

## Try it (PowerShell)

```powershell
$b = '{"jsonrpc":"2.0","method":"cancelOrder","params":{"orderId":"ORD-1002"},"id":1}'
Invoke-RestMethod http://localhost:4000/rpc -Method Post -ContentType "application/json" -Body $b
curl.exe -N http://localhost:4000/events
```

Data lives in memory and resets when the server restarts. Seed orders `ORD-1001` and `ORD-1002` are created on startup.

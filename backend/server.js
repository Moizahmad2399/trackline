const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 4000;
const ORIGIN = process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(",") : "*";
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ORIGIN } });
app.use(cors({ origin: ORIGIN }), express.json());

/* ---------- data (in memory) ---------- */
const CATALOG = [
  { sku: "KB-1", name: "Mechanical keyboard", price: 8900 },
  { sku: "MS-2", name: "Wireless mouse", price: 2400 },
  { sku: "HB-3", name: "USB-C hub", price: 3200 },
  { sku: "LS-4", name: "Laptop stand", price: 2750 },
  { sku: "EB-5", name: "Noise-cancelling earbuds", price: 6500 },
  { sku: "NB-6", name: "Notebook set", price: 850 },
];
const STEPS = ["placed", "confirmed", "packed", "out_for_delivery", "delivered"];
const CANCELLABLE = ["placed", "confirmed", "packed"];
const orders = new Map();
const chats = new Map();
let seq = 1000;

class AppError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}
const bad = (m) => new AppError("INVALID", m, 400);
const conflict = (m) => new AppError("CONFLICT", m, 409);

function getOrder(id) {
  const o = orders.get(id);
  if (!o) throw new AppError("NOT_FOUND", `Order ${id} not found`, 404);
  return o;
}

function createOrder(customerName, items) {
  const name = String(customerName || "").trim().slice(0, 40);
  if (!name) throw bad("customerName is required");
  if (!Array.isArray(items) || !items.length) throw bad("items must be a non-empty array");
  const lines = items.map((it) => {
    const { sku, qty } = it || {};
    const p = CATALOG.find((c) => c.sku === sku);
    if (!p) throw bad(`Unknown sku ${sku}`);
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw bad("qty must be a whole number from 1 to 20");
    return { sku, name: p.name, price: p.price, qty };
  });
  const at = new Date().toISOString();
  const order = {
    id: `ORD-${++seq}`, customerName: name, items: lines,
    total: lines.reduce((s, l) => s + l.price * l.qty, 0),
    status: "placed", createdAt: at, updatedAt: at, history: [{ status: "placed", at }],
  };
  orders.set(order.id, order);
  chats.set(order.id, []);
  return order;
}

function say(orderId, role, name, text) {
  const m = { orderId, role, name, text, at: new Date().toISOString() };
  chats.get(orderId).push(m);
  io.to(`order:${orderId}`).emit("chat_message", m);
}

function setStatus(id, status) {
  const o = getOrder(id);
  if (o.status === "cancelled" || o.status === "delivered") throw conflict(`Order ${id} is already ${o.status}`);
  if (status === "cancelled") {
    if (!CANCELLABLE.includes(o.status)) throw conflict(`Order ${id} is ${o.status} and can't be cancelled`);
  } else if (!STEPS.includes(status)) {
    throw bad(`status must be one of: ${STEPS.join(", ")}, cancelled`);
  } else if (STEPS.indexOf(status) <= STEPS.indexOf(o.status)) {
    throw conflict(`Order ${id} is already past ${status}`);
  }
  o.status = status;
  o.updatedAt = new Date().toISOString();
  o.history.push({ status, at: o.updatedAt });
  io.to(`order:${id}`).to("agents").emit("order_status_update", o);
  const label = status.replace(/_/g, " ");
  say(id, "system", "System", `Status changed to ${label}`);
  alert(status === "cancelled" ? "warning" : status === "delivered" ? "success" : "info", `${id} is now ${label}`);
  return o;
}

createOrder("Ayesha", [{ sku: "KB-1", qty: 1 }]);
createOrder("Bilal", [{ sku: "MS-2", qty: 2 }, { sku: "NB-6", qty: 1 }]);

/* ---------- SSE: /events ---------- */
const clients = new Set();
function alert(level, message) {
  const data = `event: alert\ndata: ${JSON.stringify({ level, message, at: new Date().toISOString() })}\n\n`;
  clients.forEach((res) => res.write(data));
}
app.get("/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("retry: 5000\n\nevent: hello\ndata: {\"message\":\"connected\"}\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
});
setInterval(() => clients.forEach((r) => r.write(": ping\n\n")), 25000);
const NOTICES = [
  ["info", "Courier network running normally"],
  ["warning", "Heavy traffic may delay some deliveries"],
  ["success", "All systems operational"],
];
setInterval(() => {
  if (clients.size) alert(...NOTICES[Math.floor(Math.random() * NOTICES.length)]);
}, 45000);

/* ---------- REST: /api/v1 ---------- */
const h = (fn) => (req, res, next) => { try { res.json(fn(req)); } catch (e) { next(e); } };
app.get("/", (req, res) => res.json({ service: "Trackline API", rest: "/api/v1", rpc: "/rpc", sse: "/events", websocket: "socket.io" }));
app.get("/api/v1/catalog", h(() => CATALOG));
app.get("/api/v1/orders", h((req) => [...orders.values()].filter((o) => !req.query.status || o.status === req.query.status)));
app.get("/api/v1/orders/:id", h((req) => getOrder(req.params.id)));
app.patch("/api/v1/orders/:id/status", h((req) => setStatus(req.params.id, req.body.status)));
app.post("/api/v1/orders", (req, res, next) => {
  try {
    const o = createOrder(req.body.customerName, req.body.items);
    io.to("agents").emit("order_created", o);
    alert("info", `New order ${o.id} from ${o.customerName}`);
    res.status(201).json(o);
  } catch (e) { next(e); }
});

/* ---------- JSON-RPC 2.0: /rpc ---------- */
const RPC_CODES = { NOT_FOUND: -32001, CONFLICT: -32002, INVALID: -32602 };
const methods = {
  cancelOrder: ({ orderId }) => setStatus(orderId, "cancelled"),
  getOrderStatus: ({ orderId }) => { const o = getOrder(orderId); return { orderId: o.id, status: o.status, updatedAt: o.updatedAt }; },
  listMethods: () => Object.keys(methods),
};
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", error: { code, message }, id });
function handle(c) {
  const id = c && c.id !== undefined ? c.id : null;
  if (!c || c.jsonrpc !== "2.0" || typeof c.method !== "string") return rpcErr(id, -32600, "Invalid Request");
  const fn = Object.hasOwn(methods, c.method) && methods[c.method];
  if (!fn) return rpcErr(id, -32601, "Method not found");
  try {
    const result = fn(c.params || {});
    return c.id === undefined ? null : { jsonrpc: "2.0", result, id };
  } catch (e) {
    return c.id === undefined ? null : rpcErr(id, RPC_CODES[e.code] || -32603, e.message);
  }
}
app.post("/rpc", (req, res) => {
  const body = req.body;
  if (Array.isArray(body) && !body.length) return res.json(rpcErr(null, -32600, "Invalid Request"));
  const out = Array.isArray(body) ? body.map(handle).filter(Boolean) : handle(body);
  return out && out.length !== 0 ? res.json(out) : res.status(204).end();
});

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return req.path === "/rpc" ? res.json(rpcErr(null, -32700, "Parse error")) : res.status(400).json({ error: "Invalid JSON body" });
  }
  if (err instanceof AppError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

/* ---------- WebSockets (Socket.io) ---------- */
const peers = new Map(); // orderId -> { customer, agent } socket ids: one of each per order
function presence(id) {
  const p = peers.get(id) || {};
  io.to(`order:${id}`).emit("presence", { orderId: id, customer: !!p.customer, agent: !!p.agent });
}
function leave(socket) {
  const c = socket.data.room;
  if (!c) return;
  const p = peers.get(c.orderId);
  if (p && p[c.role] === socket.id) delete p[c.role];
  socket.leave(`order:${c.orderId}`);
  socket.data.room = null;
  presence(c.orderId);
}

io.on("connection", (socket) => {
  socket.on("agent_join", () => socket.join("agents"));
  socket.on("agent_leave", () => socket.leave("agents"));

  socket.on("join_order_room", ({ orderId, role, name } = {}, ack = () => {}) => {
    if (!orders.has(orderId) || !["customer", "agent"].includes(role)) return ack({ ok: false, error: "Unknown order or role" });
    leave(socket);
    const p = peers.get(orderId) || {};
    peers.set(orderId, p);
    const old = p[role] && io.sockets.sockets.get(p[role]);
    if (old) { old.emit("room_replaced", { orderId }); leave(old); }
    p[role] = socket.id;
    socket.join(`order:${orderId}`);
    socket.data.room = { orderId, role, name: String(name || role).slice(0, 40) };
    socket.emit("chat_history", { orderId, messages: chats.get(orderId) });
    presence(orderId);
    ack({ ok: true });
  });

  socket.on("chat_message", ({ text } = {}) => {
    const c = socket.data.room;
    const t = String(text || "").trim().slice(0, 500);
    if (c && t) say(c.orderId, c.role, c.name, t);
  });
  socket.on("leave_order_room", () => leave(socket));
  socket.on("disconnect", () => leave(socket));
});

server.listen(PORT, () => console.log(`Trackline API on :${PORT}`));

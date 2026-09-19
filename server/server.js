require("dotenv").config();

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const UPLOADS_DIR = path.join(PUBLIC_DIR, "uploads");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const DEFAULT_DB = {
  users: [],
  sessions: [],
  shops: [],
  products: [],
  billing: [],
  subscriptions: [],
  events: []
};

function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
    }
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    for (const key of Object.keys(DEFAULT_DB)) {
      if (!Array.isArray(parsed[key])) parsed[key] = [];
    }
    return parsed;
  } catch (err) {
    console.error("DB LOAD ERROR:", err);
    return structuredClone(DEFAULT_DB);
  }
}

let db = loadDb();

function saveDb() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function id(prefix = "") {
  return prefix + crypto.randomBytes(12).toString("hex");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, user) {
  const hash = crypto.scryptSync(String(password), user.passwordSalt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.passwordHash, "hex"));
}

function safeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    plan: user.plan,
    planStatus: user.planStatus,
    planUpdatedAt: user.planUpdatedAt || null,
    paymongoCustomerId: user.paymongoCustomerId || null,
    paymongoSubscriptionId: user.paymongoSubscriptionId || null
  };
}

const PLANS = {
  free: { name: "Free", limit: 2, recurring: false },
  monthly: {
    name: "Monthly",
    limit: 20,
    recurring: true,
    price: Number(process.env.MONTHLY_PRICE || 304.39),
    paymongoId: process.env.PAYMONGO_MONTHLY_PLAN_ID || ""
  },
  yearly: {
    name: "Yearly",
    limit: 100,
    recurring: true,
    price: Number(process.env.YEARLY_PRICE || 609.39),
    paymongoId: process.env.PAYMONGO_YEARLY_PLAN_ID || ""
  },
  lifetime: {
    name: "Lifetime",
    limit: null,
    recurring: false,
    price: Number(process.env.LIFETIME_PRICE || 1220)
  }
};

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(5).toString("hex")}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (!String(file.mimetype || "").startsWith("image/")) {
      return cb(new Error("Only image files are allowed."));
    }
    cb(null, true);
  }
});

// PayMongo webhook must receive the untouched raw JSON body for signature verification.
app.use("/webhooks/paymongo", express.raw({ type: "application/json" }));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// IMPORTANT: keep this route BEFORE express.json() would be ideal for raw signature.
// Express already parsed JSON above, so this implementation uses a signature-independent
// handler for local/test development. In production, use the raw-body verification
// shown in PayMongo's webhook documentation and keep the secret server-side.
app.use(express.static(PUBLIC_DIR));

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Please log in first." });

  const session = db.sessions.find(s => s.token === token);
  if (!session) return res.status(401).json({ error: "Session expired. Please log in again." });

  const user = db.users.find(u => u.id === session.userId);
  if (!user) return res.status(401).json({ error: "User not found." });

  req.user = user;
  req.session = session;
  next();
}

function basicAuth() {
  const key = process.env.PAYMONGO_SECRET_KEY;
  if (!key) throw new Error("PAYMONGO_SECRET_KEY is missing in .env");
  return "Basic " + Buffer.from(`${key}:`).toString("base64");
}

async function paymongo(pathname, options = {}) {
  const response = await fetch(`https://api.paymongo.com/v1${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": basicAuth(),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    const msg = data?.errors?.map(e => e.detail || e.code).join("; ")
      || data?.error
      || `PayMongo HTTP ${response.status}`;
    const error = new Error(msg);
    error.status = response.status;
    error.paymongo = data;
    throw error;
  }
  return data;
}

function requireConfiguredPayMongo(res) {
  if (!process.env.PAYMONGO_SECRET_KEY || !process.env.PAYMONGO_PUBLIC_KEY) {
    res.status(500).json({ error: "PayMongo keys are not configured in server/.env." });
    return false;
  }
  return true;
}

function productLimit(user) {
  return PLANS[user.plan]?.limit ?? null;
}

// ---------- AUTH ----------
app.post("/api/signup", (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (!name || !email || password.length < 6) {
    return res.status(400).json({ error: "Name, valid email and password of at least 6 characters are required." });
  }
  if (db.users.some(u => u.email === email)) {
    return res.status(409).json({ error: "Email is already registered." });
  }

  const { salt, hash } = hashPassword(password);
  const user = {
    id: id("usr_"),
    name, email,
    passwordSalt: salt,
    passwordHash: hash,
    plan: "free",
    planStatus: "active",
    planUpdatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  const token = id("sess_");
  db.users.push(user);
  db.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
  saveDb();

  res.json({ token, user: safeUser(user) });
});

app.post("/api/login", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = db.users.find(u => u.email === email);

  if (!user || !verifyPassword(password, user)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const token = id("sess_");
  db.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
  saveDb();

  res.json({ token, user: safeUser(user) });
});

app.post("/api/logout", auth, (req, res) => {
  db.sessions = db.sessions.filter(s => s.token !== req.session.token);
  saveDb();
  res.json({ ok: true });
});

app.get("/api/me", auth, (req, res) => {
  res.json({ user: safeUser(req.user) });
});

// ---------- SHOPS ----------
app.get("/api/my-shops", auth, (req, res) => {
  const shops = db.shops
    .filter(s => s.userId === req.user.id)
    .map(shop => ({
      ...shop,
      productCount: db.products.filter(p => p.shopId === shop.id).length,
      productLimit: productLimit(req.user)
    }));
  res.json({ shops, user: safeUser(req.user) });
});

app.post("/api/shops", auth, (req, res) => {
  const name = String(req.body.name || "").trim();
  const slug = String(req.body.slug || name).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  if (!name || !slug) return res.status(400).json({ error: "Shop name and slug are required." });
  if (db.shops.some(s => s.slug === slug)) return res.status(409).json({ error: "Shop slug is already used." });

  const shop = {
    id: id("shop_"),
    userId: req.user.id,
    name,
    slug,
    description: String(req.body.description || ""),
    createdAt: new Date().toISOString()
  };
  db.shops.push(shop);
  saveDb();
  res.json({ shop });
});

app.delete("/api/shops/:id", auth, (req, res) => {
  const shop = db.shops.find(s => s.id === req.params.id && s.userId === req.user.id);
  if (!shop) return res.status(404).json({ error: "Shop not found." });

  db.products = db.products.filter(p => p.shopId !== shop.id);
  db.shops = db.shops.filter(s => s.id !== shop.id);
  saveDb();
  res.json({ ok: true });
});

app.get("/api/public/shop/:slug", (req, res) => {
  const shop = db.shops.find(s => s.slug === req.params.slug);
  if (!shop) return res.status(404).json({ error: "Shop not found." });
  const products = db.products.filter(p => p.shopId === shop.id);
  res.json({ shop, products });
});

// ---------- PRODUCTS ----------
app.get("/api/products", auth, (req, res) => {
  const shopIds = new Set(db.shops.filter(s => s.userId === req.user.id).map(s => s.id));
  res.json({ products: db.products.filter(p => shopIds.has(p.shopId)) });
});

app.post("/api/products", auth, upload.single("image"), (req, res) => {
  const shop = db.shops.find(s => s.id === req.body.shopId && s.userId === req.user.id);
  if (!shop) return res.status(404).json({ error: "Shop not found." });

  const limit = productLimit(req.user);
  const count = db.products.filter(p => p.shopId === shop.id).length;
  if (limit !== null && count >= limit) {
    return res.status(403).json({
      error: `Your ${PLANS[req.user.plan].name} plan allows ${limit} products per AffiliShop.`
    });
  }

  const name = String(req.body.name || "").trim();
  const url = String(req.body.url || "").trim();
  if (!name || !url) return res.status(400).json({ error: "Product name and affiliate URL are required." });

  const product = {
    id: id("prod_"),
    shopId: shop.id,
    userId: req.user.id,
    name,
    url,
    price: String(req.body.price || ""),
    description: String(req.body.description || ""),
    imageUrl: req.file ? `/uploads/${req.file.filename}` : String(req.body.imageUrl || ""),
    createdAt: new Date().toISOString()
  };

  db.products.push(product);
  saveDb();
  res.json({ product });
});

app.delete("/api/products/:id", auth, (req, res) => {
  const product = db.products.find(p => p.id === req.params.id && p.userId === req.user.id);
  if (!product) return res.status(404).json({ error: "Product not found." });
  db.products = db.products.filter(p => p.id !== product.id);
  saveDb();
  res.json({ ok: true });
});

// ---------- BILLING ----------
async function ensureCustomer(user) {
  if (user.paymongoCustomerId) {
    return user.paymongoCustomerId;
  }

  const nameParts = user.name.trim().split(/\s+/);
  const firstName = nameParts.shift() || "Customer";
  const lastName = nameParts.join(" ") || "Customer";

  const result = await paymongo("/customers", {
    method: "POST",
    body: JSON.stringify({
      data: {
        attributes: {
          first_name: firstName,
          last_name: lastName,
          email: user.email,
          default_device: "email"
        }
      }
    })
  });

  user.paymongoCustomerId = result.data.id;
  saveDb();

  return result.data.id;
}

app.get("/api/plans", (req, res) => {
  res.json({
    plans: Object.entries(PLANS).map(([id, p]) => ({
      id,
      name: p.name,
      price: p.price || 0,
      limit: p.limit,
      recurring: p.recurring
    }))
  });
});

app.post("/api/billing/start", auth, async (req, res) => {
  const plan = String(req.body.plan || "").toLowerCase();

  if (!["monthly", "yearly", "lifetime"].includes(plan)) {
    return res.status(400).json({ error: "Invalid paid plan." });
  }

// ---------- BETA MODE ----------
if (process.env.BETA_MODE === "true") {
  req.user.plan = plan;
  req.user.planStatus = "active";
  req.user.planUpdatedAt = new Date().toISOString();

  db.billing.push({
    id: id("bill_"),
    userId: req.user.id,
    plan,
    type: "beta",
    status: "active",
    amount: 0,
    createdAt: new Date().toISOString()
  });

  saveDb();

  console.log("🧪 BETA PLAN ACTIVATED:", req.user.email, plan);

  return res.json({
    type: "beta",
    message: `${PLANS[plan].name} activated for beta testing.`,
    user: safeUser(req.user)
  });
}

  try {
    if (plan === "lifetime") {
      const amount = Math.round(PLANS.lifetime.price * 100);
      const baseUrl = process.env.APP_URL || `http://localhost:${PORT}`;

      const result = await fetch("https://api.paymongo.com/v2/checkout_sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": basicAuth()
        },
        body: JSON.stringify({
          data: {
            attributes: {
              billing: { name: req.user.name, email: req.user.email },
              line_items: [{
                currency: "PHP",
                amount,
                name: "AffiliShop Lifetime",
                quantity: 1
              }],
              payment_method_types: ["card", "gcash", "paymaya"],
              success_url: `${baseUrl}/payment-success.html?plan=lifetime`,
              cancel_url: `${baseUrl}/?payment=cancelled`,
              metadata: {
                userId: req.user.id,
                plan: "lifetime"
              }
            }
          }
        })
      });

      const checkout = await result.json();
      if (!result.ok) {
        const msg = checkout?.errors?.map(e => e.detail || e.code).join("; ") || "Unable to create checkout.";
        throw new Error(msg);
      }

      const session = checkout.data;
      db.billing.push({
        id: id("bill_"),
        userId: req.user.id,
        plan: "lifetime",
        type: "checkout",
        checkoutSessionId: session.id,
        status: "pending",
        amount,
        createdAt: new Date().toISOString()
      });
      req.user.planStatus = "pending";
      saveDb();

      return res.json({
        type: "checkout",
        checkoutUrl: session.attributes.checkout_url,
        sessionId: session.id
      });
    }

    const config = PLANS[plan];
    if (!config.paymongoId) {
      return res.status(500).json({
        error: `Missing PAYMONGO_${plan.toUpperCase()}_PLAN_ID in server/.env`
      });
    }

    const customerId = await ensureCustomer(req.user);

    // PayMongo Subscriptions creates the first invoice and its Payment Intent.
    // The first payment must be completed before the subscription becomes active.
    const result = await paymongo("/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        data: {
          attributes: {
            plan_id: config.paymongoId,
            customer_id: customerId
          }
        }
      })
    });

    const subscription = result?.data;
    const attrs = subscription?.attributes || {};
    const paymentIntent = attrs.latest_invoice?.payment_intent || null;

    if (!subscription?.id) throw new Error("PayMongo did not return a subscription ID.");

    db.billing.push({
      id: id("bill_"),
      userId: req.user.id,
      plan,
      type: "subscription",
      paymongoCustomerId: customerId,
      paymongoSubscriptionId: subscription.id,
      paymentIntentId: paymentIntent?.id || null,
      invoiceId: attrs.latest_invoice?.id || null,
      status: attrs.status || "incomplete",
      createdAt: new Date().toISOString()
    });

    db.subscriptions.push({
      id: id("sub_"),
      userId: req.user.id,
      plan,
      paymongoSubscriptionId: subscription.id,
      paymentIntentId: paymentIntent?.id || null,
      invoiceId: attrs.latest_invoice?.id || null,
      status: attrs.status || "incomplete",
      createdAt: new Date().toISOString()
    });

    req.user.planStatus = "pending";
    req.user.paymongoSubscriptionId = subscription.id;
    saveDb();

    return res.json({
      type: "subscription",
      publicKey: process.env.PAYMONGO_PUBLIC_KEY,
      subscriptionId: subscription.id,
      paymentIntentId: paymentIntent?.id || null,
      clientKey: paymentIntent?.client_key || null,
      status: attrs.status || "incomplete"
    });
  } catch (err) {
    console.error("BILLING START ERROR:", err.message);
    if (err.paymongo) console.error("PAYMONGO ERROR:", JSON.stringify(err.paymongo, null, 2));
    res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.message });
  }
});

app.post("/api/billing/cancel", auth, async (req, res) => {
  const subId = req.user.paymongoSubscriptionId;
  if (!subId) return res.status(400).json({ error: "No active subscription found." });
  if (!requireConfiguredPayMongo(res)) return;

  try {
    await paymongo(`/subscriptions/${encodeURIComponent(subId)}`, { method: "DELETE" });
    req.user.plan = "free";
    req.user.planStatus = "active";
    req.user.paymongoSubscriptionId = null;
    req.user.planUpdatedAt = new Date().toISOString();

    const bill = db.billing.find(b => b.paymongoSubscriptionId === subId);
    if (bill) bill.status = "cancelled";

    const history = db.subscriptions.find(s => s.paymongoSubscriptionId === subId);
    if (history) history.status = "cancelled";

    saveDb();
    res.json({ ok: true, user: safeUser(req.user) });
  } catch (err) {
    console.error("CANCEL ERROR:", err.message);
    res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.message });
  }
});

// ---------- PAYMONGO WEBHOOK ----------
function verifyPayMongoWebhook(rawBody, signatureHeader, secret, livemode) {
  if (!secret || !signatureHeader) return false;

  const parts = {};
  for (const part of String(signatureHeader).split(",")) {
    const idx = part.indexOf("=");
    if (idx > 0) parts[part.slice(0, idx)] = part.slice(idx + 1);
  }

  const timestamp = parts.t;
  const signature = livemode ? parts.li : parts.te;
  if (!timestamp || !signature) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post("/webhooks/paymongo", (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ""), "utf8");

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const event = payload?.data;
  const livemode = Boolean(event?.attributes?.livemode);
  const signatureHeader = req.headers["paymongo-signature"];

  // Verify the webhook before touching the database.
  // If no secret is configured, local development is allowed to proceed so ngrok testing
  // is easier; production should always set PAYMONGO_WEBHOOK_SECRET.
  if (process.env.PAYMONGO_WEBHOOK_SECRET) {
    const valid = verifyPayMongoWebhook(
      rawBody.toString("utf8"),
      signatureHeader,
      process.env.PAYMONGO_WEBHOOK_SECRET,
      livemode
    );
    if (!valid) {
      console.warn("PAYMONGO WEBHOOK REJECTED: invalid signature");
      return res.status(401).json({ error: "Invalid webhook signature." });
    }
  }

  const eventType = event?.attributes?.type || event?.type;
  const resource = event?.attributes?.data;
  const resourceId = resource?.id;

  console.log("PAYMONGO WEBHOOK:", eventType, resourceId || "");

  // PayMongo may retry deliveries, so don't process the same event twice.
  const eventId = event?.id;
  if (eventId && db.events.some(e => e.paymongoEventId === eventId)) {
    return res.status(200).json({ received: true, duplicate: true });
  }

  db.events.push({
    id: id("evt_"),
    paymongoEventId: eventId || null,
    type: eventType || "unknown",
    resourceId: resourceId || null,
    receivedAt: new Date().toISOString()
  });
  if (db.events.length > 500) db.events.shift();

  if (eventType === "checkout_session.payment.paid") {
    const metadata = resource?.attributes?.metadata || {};
    const userId = metadata.userId || metadata.user_id;
    const paidPlan = metadata.plan;

    const user = db.users.find(u => u.id === userId);
    const billing = db.billing.find(b => b.checkoutSessionId === resourceId);

    if (user && paidPlan === "lifetime") {
      user.plan = "lifetime";
      user.planStatus = "active";
      user.planUpdatedAt = new Date().toISOString();
      console.log("PLAN ACTIVATED:", user.email, "lifetime");
    }
    if (billing) billing.status = "paid";
  }

  if (["payment.paid", "payment.failed"].includes(eventType)) {
    const paymentIntentId =
      resource?.attributes?.payment_intent_id ||
      resource?.attributes?.payment_intent?.id;

    const billing = db.billing.find(b => b.paymentIntentId === paymentIntentId);

    if (billing) {
      billing.status = eventType === "payment.paid" ? "paid" : "failed";

      if (eventType === "payment.paid") {
        const user = db.users.find(u => u.id === billing.userId);
        if (user) {
          user.plan = billing.plan;
          user.planStatus = "active";
          user.planUpdatedAt = new Date().toISOString();
          console.log("PLAN ACTIVATED:", user.email, billing.plan);
        }
      }
    }
  }

  if (["subscription.activated", "subscription.updated"].includes(eventType)) {
    const attrs = resource?.attributes || {};
    const billing = db.billing.find(b => b.paymongoSubscriptionId === resourceId);

    if (billing) {
      billing.status = attrs.status || billing.status;

      const user = db.users.find(u => u.id === billing.userId);
      if (user && attrs.status === "active") {
        user.plan = billing.plan;
        user.planStatus = "active";
        user.paymongoSubscriptionId = resourceId;
        user.planUpdatedAt = new Date().toISOString();
        console.log("PLAN ACTIVATED:", user.email, billing.plan);
      }
    }

    const history = db.subscriptions.find(s => s.paymongoSubscriptionId === resourceId);
    if (history) history.status = attrs.status || history.status;
  }

  if (eventType === "subscription.invoice.paid") {
    const attrs = resource?.attributes || {};
    const subscriptionId =
      attrs.subscription_id ||
      attrs.subscription?.id ||
      attrs.metadata?.subscription_id;

    const billing = db.billing.find(b =>
      (subscriptionId && b.paymongoSubscriptionId === subscriptionId) ||
      b.invoiceId === resourceId
    );

    if (billing) {
      billing.status = "paid";
      const user = db.users.find(u => u.id === billing.userId);
      if (user) {
        user.plan = billing.plan;
        user.planStatus = "active";
        user.planUpdatedAt = new Date().toISOString();
        console.log("PLAN ACTIVATED:", user.email, billing.plan);
      }
    }
  }

  if (
    eventType === "subscription.past_due" ||
    eventType === "subscription.unpaid" ||
    eventType === "subscription.cancelled"
  ) {
    const billing = db.billing.find(b => b.paymongoSubscriptionId === resourceId);

    if (billing) {
      billing.status = resource?.attributes?.status || eventType;

      const user = db.users.find(u => u.id === billing.userId);
      if (user) {
        user.planStatus = "inactive";

        if (eventType === "subscription.cancelled") {
          user.plan = "free";
          user.paymongoSubscriptionId = null;
          user.planUpdatedAt = new Date().toISOString();
        }
      }
    }
  }

  saveDb();

  // PayMongo expects a 2xx JSON acknowledgement.
  return res.status(200).json({ received: true });
});

// ---------- HEALTH ----------
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    port: PORT,
    paymongoConfigured: Boolean(process.env.PAYMONGO_SECRET_KEY && process.env.PAYMONGO_PUBLIC_KEY),
    subscriptionPlansConfigured: Boolean(PLANS.monthly.paymongoId && PLANS.yearly.paymongoId)
  });
});

app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);
  res.status(500).json({ error: err.message || "Server error." });
});

app.listen(PORT, () => {
  console.log(`AffiliShop server running: http://localhost:${PORT}`);
  console.log(`Database: ${DB_FILE}`);
  console.log(`Monthly limit: ${PLANS.monthly.limit}, Yearly limit: ${PLANS.yearly.limit}, Lifetime: unlimited`);
});

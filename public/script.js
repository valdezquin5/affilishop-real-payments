"use strict";
const KEY = {
  users: "affiliShopUsers",
  current: "affiliShopCurrentUser",
  products: "affiliShopProducts",
  stats: "affiliateStats",
  favorites: "favorites",
  dark: "affiliShopDarkMode",
  shops: "affiliShopCreatedShops",
  plan: "affiliShopPlan"
};

const PLAN_LIMITS = {
  free: 2,
  monthly: 20,
  yearly: 100,
  lifetime: Infinity
};

const FALLBACK_IMAGE = "https://via.placeholder.com/700x500?text=AffiliShop";
const DEFAULT_PRODUCTS = [
  ["Wireless Earbuds","electronics",29.99,49.99,4,"Best Seller","https://images.unsplash.com/photo-1606220945770-b5b6c2c55bf1?auto=format&fit=crop&w=800&q=80","https://example.com/affiliate/earbuds"],
  ["Smart Watch","electronics",49.99,79.99,5,"Trending","https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=800&q=80","https://example.com/affiliate/watch"],
  ["Fashion Handbag","fashion",39.99,69.99,4.5,"Trending","https://images.unsplash.com/photo-1584917865442-de89df76afd3?auto=format&fit=crop&w=800&q=80","https://example.com/affiliate/handbag"],
  ["Running Shoes","fashion",59.99,89.99,7,"Hot Deal","https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=800&q=80","https://example.com/affiliate/shoes"],
  ["LED Desk Lamp","home",19.99,39.99,3,"New","https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=800&q=80","https://example.com/affiliate/lamp"],
  ["Premium Sunglasses","fashion",24.99,44.99,3.5,"New","https://images.unsplash.com/photo-1511499767150-a48a237f0083?auto=format&fit=crop&w=800&q=80","https://example.com/affiliate/sunglasses"]
];

let currentUser = null;
let authToken = "";
let products = null;
let stats = { clicks: 0, shared: 0, commission: 0 };
let favorites = [];
let shops = [];
let currentPlan = "free";
let activeShopId = null;
let category = "all";
let resetUserId = null;

const $ = id => document.getElementById(id);
const read = (key, fallback) => {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch { return fallback; }
};
const write = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const esc = value => String(value ?? "")
  .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
  .replaceAll('"',"&quot;").replaceAll("'","&#039;");

const toast = (message) => {
  const el = $("toast"); if (!el) return;
  el.textContent = message; el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 3000);
};

const openModal = (id) => { const m = $(id); if (!m) return; m.classList.add("show"); document.body.style.overflow = "hidden"; };
const closeModals = () => { document.querySelectorAll(".modal.show").forEach(m => m.classList.remove("show")); document.body.style.overflow = ""; };

const planLimit = () => PLAN_LIMITS[currentPlan] ?? 2;
const planName = () => ({ free:"Free", monthly:"Monthly", yearly:"Yearly", lifetime:"Lifetime" }[currentPlan] || "Free");
const validUrl = (value) => { if (!value) return true; try { const u = new URL(value); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; } };
const slugify = (value) => String(value).toLowerCase().trim().replace(/[^a-z0-9\s-]/g,"").replace(/\s+/g,"-").replace(/-+/g,"-").slice(0,40);
const getActiveShop = () => {
  if (!currentUser) return null;
  const mine = shops.filter(s => s.ownerId === currentUser.id);
  return (activeShopId ? mine.find(s => s.id === activeShopId) : mine[0]) || null;
};

const updateAuth = () => {
  const logged = !!currentUser;
  $("loginButton")?.classList.toggle("hidden", logged);
  $("signupButton")?.classList.toggle("hidden", logged);
  $("logoutButton")?.classList.toggle("hidden", !logged);
  if ($("userDisplay")) $("userDisplay").textContent = logged ? `👤 ${currentUser.name}` : "";
};

const updateStats = () => {
  if ($("clicks")) $("clicks").textContent = stats.clicks;
  if ($("shared")) $("shared").textContent = stats.shared;
  if ($("commission")) $("commission").textContent = `$${Number(stats.commission||0).toFixed(2)}`;
  if ($("balance")) $("balance").textContent = `$${Number(stats.commission||0).toFixed(2)}`;
};

const updateAccount = () => {
  if (!currentUser) return;
  if ($("accountName")) $("accountName").textContent = currentUser.name;
  if ($("accountEmail")) $("accountEmail").textContent = currentUser.email;
  if ($("accountPhone")) $("accountPhone").textContent = currentUser.phone;
};

const saveEverything = () => {
  write(KEY.products, products);
  write(KEY.stats, stats);
  write(KEY.favorites, favorites);
  write(KEY.shops, shops);
};

// --- FUNCTIONS DECLARED FIRST ---

async function restoreServerSession() {
  const token =
    authToken ||
    localStorage.getItem(
      "affiliShopAuthToken"
    );

  if (!token) {
    currentUser = null;
    authToken = "";
    currentPlan = "free";
    return;
  }

  try {
    const res = await fetch(
      "/api/me",
      {
        headers: {
          "Authorization":
            `Bearer ${token}`
        }
      }
    );

    const data =
      await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(
        data.error ||
        "Session expired."
      );
    }

    authToken = token;

    currentUser = data.user;

    write(
      KEY.current,
      currentUser
    );

    currentPlan =
      currentUser.plan ||
      "free";

    localStorage.setItem(
      KEY.plan,
      currentPlan
    );

  } catch (error) {
    console.error(
      "SESSION ERROR:",
      error
    );

    authToken = "";
    currentUser = null;
    currentPlan = "free";

    localStorage.removeItem(
      "affiliShopAuthToken"
    );

    localStorage.removeItem(
      KEY.current
    );

    localStorage.removeItem(
      KEY.plan
    );
  }
}

async function login() {
  const identity =
    $("loginIdentity")?.value.trim().toLowerCase() || "";

  const password =
    $("loginPassword")?.value || "";

  if (!identity || !password) {
    return toast("Enter your email and password.");
  }

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: identity,
        password
      })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(
        data.error ||
        "Invalid email or password."
      );
    }

    if (!data.token || !data.user) {
      throw new Error(
        "Server did not return a valid session."
      );
    }

    authToken = data.token;

    localStorage.setItem(
      "affiliShopAuthToken",
      authToken
    );

    currentUser = data.user;

    write(
      KEY.current,
      currentUser
    );

    currentPlan =
      currentUser.plan || "free";

    localStorage.setItem(
      KEY.plan,
      currentPlan
    );

    updateAuth();
    updateAccess();
    closeModals();

    toast("Login successful! 👋");

  } catch (error) {
    console.error(
      "LOGIN ERROR:",
      error
    );

    toast(
      error.message ||
      "Login failed."
    );
  }
}

async function logout() {
  if (authToken) try { await fetch("/api/logout", { method: "POST", headers: { "Authorization": `Bearer ${authToken}` } }); } catch {}
  authToken = ""; currentUser = null; activeShopId = null;
  localStorage.removeItem("affiliShopAuthToken"); localStorage.removeItem(KEY.current); localStorage.removeItem(KEY.plan);
  currentPlan = "free";
  updateAuth(); updateAccess(); renderProducts();
  toast("Logged out.");
}

async function signup() {
  const name = $("signupName")?.value.trim() || "";
  const email = $("signupEmail")?.value.trim().toLowerCase() || "";
  const phone = $("signupPhone")?.value.trim() || "";
  const password = $("signupPassword")?.value || "";
  const confirm = $("signupConfirm")?.value || "";

  if (!name || !email || !phone || !password || !confirm) {
    return toast("Complete all fields.");
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return toast("Enter a valid email.");
  }

  if (password.length < 6) {
    return toast("Password must be at least 6 characters.");
  }

  if (password !== confirm) {
    return toast("Passwords do not match.");
  }

  try {
    const res = await fetch("/api/signup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name,
        email,
        phone,
        password
      })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || "Registration failed.");
    }

    if (!data.token || !data.user) {
      throw new Error("Server did not return a valid account session.");
    }

    authToken = data.token;

    localStorage.setItem(
      "affiliShopAuthToken",
      authToken
    );

    currentUser = data.user;

    write(KEY.current, currentUser);

    currentPlan = currentUser.plan || "free";

    localStorage.setItem(
      KEY.plan,
      currentPlan
    );

    updateAuth();
    updateAccess();
    closeModals();

    toast("🎉 Account created successfully!");

  } catch (error) {
    console.error("SIGNUP ERROR:", error);

    toast(
      error.message ||
      "Registration failed."
    );
  }
}

function openShopCreator() {
  if (!currentUser) { openModal("signupModal"); toast("Please sign up first."); return; }
  $("shopName").value = ""; $("shopDescription").value = ""; $("shopSlug").value = "";
  openModal("shopModal");
}

function saveShop() {
  const name = $("shopName").value.trim();
  const description = $("shopDescription").value.trim();
  const slug = slugify($("shopSlug").value || name);
  if (!name) return toast("Enter shop name.");
  if (!slug) return toast("Enter valid shop link.");
  const mine = shops.filter(s => s.ownerId === currentUser.id);
  if (mine.some(s => s.slug === slug)) return toast("Shop link already used.");
  const shop = { id: Date.now(), ownerId: currentUser.id, name, description, slug, products: [], createdAt: new Date().toISOString() };
  shops.push(shop); activeShopId = shop.id;
  write(KEY.shops, shops); renderShops(); closeModals();
  toast(`🎉 ${name} created. Limit: ${planLimit()} products.`);
}

function manageShop(id) {
  const shop = shops.find(s => s.id === Number(id) && s.ownerId === currentUser.id);
  if (!shop) return;
  activeShopId = shop.id;
  toast(`Managing "${shop.name}"`);
}

function deleteShop(id) {
  const shop = shops.find(s => s.id === Number(id) && s.ownerId === currentUser.id);
  if (!shop || !confirm(`Delete "${shop.name}"?`)) return;
  shops = shops.filter(s => s.id !== shop.id);
  if (activeShopId === shop.id) activeShopId = null;
  write(KEY.shops, shops); renderShops(); toast("Shop deleted.");
}

function openProductForm(product = null) {
  $("productId").value = product?.id || "";
  $("productModalTitle").textContent = product ? "Edit Product" : "Add Product";
  $("productName").value = product?.name || "";
  $("productCategory").value = product?.category || "electronics";
  $("productPrice").value = product?.price ?? "";
  $("productOldPrice").value = product?.old ?? "";
  $("productCommission").value = product?.commission ?? "";
  $("productBadge").value = product?.badge || "New";
  $("productImage").value = product?.image || "";
  $("productAffiliate").value = product?.affiliate || "";
  openModal("productModal");
}

function saveProduct() {
  if (!currentUser) return toast("Sign up first.");
  const id = Number($("productId").value) || null;
  const name = $("productName").value.trim();
  const categoryValue = $("productCategory").value;
  const price = Number($("productPrice").value);
  const old = Number($("productOldPrice").value) || 0;
  const commission = Number($("productCommission").value);
  const badge = $("productBadge").value.trim() || "New";
  const image = $("productImage").value.trim() || FALLBACK_IMAGE;
  const affiliate = $("productAffiliate").value.trim();
  if (!name) return toast("Enter product name.");
  if (!Number.isFinite(price) || price < 0) return toast("Enter valid price.");
  if (!Number.isFinite(commission) || commission < 0) return toast("Enter valid commission.");
  if (!validUrl(image) || !validUrl(affiliate)) return toast("Use valid http/https URLs.");
  const shop = getActiveShop();
  if (!id && !shop) { closeModals(); openShopCreator(); return toast("Create a shop first."); }
  if (!id && shop && shop.products.length >= planLimit()) { closeModals(); openPlans(); return toast(`Limit reached for ${planName()} plan.`); }
  
  if (id) {
    const idx = products.findIndex(p => p.id === id);
    if (idx < 0) return toast("Product not found.");
    products[idx] = { ...products[idx], name, category: categoryValue, price, old, commission, badge, image, affiliate };
    shops.forEach(s => { const i = s.products.findIndex(p => p.id === id); if (i >= 0) s.products[i] = { ...products[idx] }; });
    toast("Product updated! ✅");
  } else {
    const newP = { id: Date.now(), name, category: categoryValue, price, old, commission, badge, image, affiliate };
    products.push(newP); shop.products.push({ ...newP });
    toast("Product added! ✅");
  }
  saveEverything(); renderProducts(); renderShops(); closeModals();
}

function deleteProduct(id) {
  const p = products.find(x => x.id === Number(id));
  if (!p || !confirm(`Delete "${p.name}"?`)) return;
  products = products.filter(x => x.id !== Number(id));
  shops.forEach(sh => { sh.products = sh.products.filter(x => x.id !== Number(id)); });
  favorites = favorites.filter(x => x !== Number(id));
  saveEverything(); renderProducts(); renderShops(); toast("Product deleted.");
}

async function shareProduct(id) {
  const p = products.find(x => x.id === Number(id));
  if (!p) return;
  const link = validUrl(p.affiliate) ? p.affiliate : "#";
  if (link === "#") return toast("Invalid affiliate URL.");
  if (!currentUser) { window.open(link, "_blank", "noopener,noreferrer"); return; }
  stats.clicks += 1; stats.shared += 1; stats.commission += Number(p.commission) || 0;
  write(KEY.stats, stats); updateStats();
  try { await navigator.clipboard.writeText(link); toast("Link copied! 🔗"); }
  catch { window.prompt("Copy link:", link); }
}

function viewPublicProduct(id) {
  const p = products.find(x => x.id === Number(id));
  if (!p) return;
  const link = validUrl(p.affiliate) ? p.affiliate : "#";
  $("publicProductImage").src = p.image || FALLBACK_IMAGE;
  $("publicProductImage").alt = p.name;
  $("publicProductTitle").textContent = p.name;
  $("publicProductPrice").textContent = `$${Number(p.price||0).toFixed(2)}`;
  const commEl = $("publicProductCommission");
  commEl.textContent = `🟢 Earn $${Number(p.commission||0).toFixed(2)}`;
  commEl.style.display = currentUser ? "inline-flex" : "none";
  $("publicProductCategory").textContent = `Category: ${p.category||"General"}`;
  $("publicProductBadge").textContent = p.badge || "Featured";
  const linkEl = $("publicProductLink");
  linkEl.href = link;
  linkEl.style.pointerEvents = link === "#" ? "none" : "auto";
  linkEl.style.opacity = link === "#" ? "0.5" : "1";
  linkEl.textContent = link === "#" ? "Link Unavailable" : "Visit Product →";
  openModal("publicProductModal");
}

function viewShop(id) {
  const shop = shops.find(s => s.id === Number(id));
  if (!shop) return;
  $("publicShopTitle").textContent = shop.name;
  $("publicShopDescription").textContent = shop.description || "Select a product.";
  const box = $("publicShopProducts"); box.innerHTML = "";
  if (!shop.products.length) {
    box.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:35px"><h3>No products yet.</h3></div>`;
  } else {
    shop.products.forEach(p => {
      const card = document.createElement("div"); card.className = "public-product";
      const link = validUrl(p.affiliate) ? p.affiliate : "#";
      card.innerHTML = `
        <img src="${esc(p.image||FALLBACK_IMAGE)}" alt="${esc(p.name)}" onerror="this.src='${FALLBACK_IMAGE}'">
        <div class="public-product-info">
          <h3>${esc(p.name)}</h3>
          <p>$${Number(p.price).toFixed(2)}</p>
          <a class="public-product-link" href="${esc(link)}" target="_blank" rel="noopener noreferrer" data-public-link="${p.id}">View Product →</a>
        </div>`;
      box.appendChild(card);
    });
  }
  openModal("publicShopModal");
}

async function choosePlan(plan) {
  if (!plan) return;

  if (!currentUser) {
    return toast("Login first.");
  }

  try {
    const token = localStorage.getItem("affiliShopAuthToken");

    if (!token) {
      return toast("Please login again.");
    }

    const res = await fetch("/api/billing/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        plan: plan
      })
    });

    const raw = await res.text();

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Server returned ${res.status}`);
    }

    if (!res.ok) {
      throw new Error(data.error || `Payment failed (${res.status})`);
    }

    if (data.type === "checkout" && data.checkoutUrl) {
      window.location.href = data.checkoutUrl;
      return;
    }

     if (data.type === "beta") {
        currentUser = {
    ...currentUser,
    ...data.user
  };

       localStorage.setItem(
      "affiliShopCurrentUser",
       JSON.stringify(currentUser)
  );

      toast(`${data.user.plan} plan activated — Beta Mode`);

      setTimeout(() => {
      window.location.reload();
  }, 700);

  return;
}
    if (data.type === "subscription") {
      console.log("Subscription created:", data);
      toast("Subscription created. Continue with payment.");
      return;
    }

    throw new Error("No payment URL returned.");

  } catch (e) {
    console.error("PAYMENT ERROR:", e);
    toast(e.message || "Payment failed.");
  }
}

function openPlans() { openModal("plansModal"); }
function resetStats() { if (confirm("Reset stats?")) { stats = { clicks:0, shared:0, commission:0 }; write(KEY.stats, stats); updateStats(); toast("Stats reset."); } }
function startReset() { resetUserId = null; $("forgotIdentity").value = ""; $("newPassword").value = ""; $("confirmNewPassword").value = ""; $("resetStep2")?.classList.add("hidden"); openModal("forgotModal"); }
async function verifyReset() {
  const identity =
    $("forgotIdentity")?.value.trim().toLowerCase() || "";

  if (!identity) {
    return toast(
      "Enter your email or phone."
    );
  }

  try {
    const res = await fetch(
      "/api/reset-password/check",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contact: identity
        })
      }
    );

    const data =
      await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(
        data.error ||
        "Account not found."
      );
    }

    resetUserId = identity;

    $("resetStep2")?.classList.remove(
      "hidden"
    );

    toast(
      "Account found. Enter your new password."
    );

  } catch (error) {
    console.error(
      "VERIFY RESET ERROR:",
      error
    );

    toast(
      error.message ||
      "Account not found."
    );
  }
}
async function resetPassword() {
  if (!resetUserId) {
    return toast(
      "Enter your email or phone first."
    );
  }

  const password =
    $("newPassword")?.value || "";

  const confirm =
    $("confirmNewPassword")?.value || "";

  if (password.length < 6) {
    return toast(
      "Password must be at least 6 characters."
    );
  }

  if (password !== confirm) {
    return toast(
      "Passwords do not match."
    );
  }

  try {
    const res = await fetch(
      "/api/reset-password",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contact: resetUserId,
          newPassword: password
        })
      }
    );

    const data =
      await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(
        data.error ||
        "Password reset failed."
      );
    }

    resetUserId = null;

    if ($("newPassword")) {
      $("newPassword").value = "";
    }

    if ($("confirmNewPassword")) {
      $("confirmNewPassword").value = "";
    }

    closeModals();

    openModal("loginModal");

    toast(
      "Password changed successfully! 🔐"
    );

  } catch (error) {
    console.error(
      "RESET PASSWORD ERROR:",
      error
    );

    toast(
      error.message ||
      "Password reset failed."
    );
  }
}

function renderProducts() {
  const grid = $("productGrid"); if (!grid) return;
  const q = ($("searchInput")?.value || "").trim().toLowerCase();
  const list = products.filter(p => (category === "all" || p.category === category) && (!q || `${p.name} ${p.category} ${p.badge}`.toLowerCase().includes(q)));
  grid.innerHTML = "";
  if (!list.length) { grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:60px"><h3>No products found</h3></div>`; return; }
  const activeShop = getActiveShop();
  const ownerIds = activeShop ? new Set(activeShop.products.map(p => p.id)) : new Set();
  list.forEach(p => {
    const liked = favorites.includes(p.id);
    const canManage = !!currentUser && ownerIds.has(p.id);
    const card = document.createElement("article");
    card.className = "product-card"; card.dataset.productView = p.id;
    card.setAttribute("role", "button"); card.setAttribute("tabindex", "0");
    card.innerHTML = `
      <div class="product-image">
        <img src="${esc(p.image||FALLBACK_IMAGE)}" alt="${esc(p.name)}" onerror="this.src='${FALLBACK_IMAGE}'">
        <div class="badge">${esc(p.badge||"New")}</div>
        <button class="heart ${liked?"active":""}" type="button" data-action="favorite" data-id="${p.id}">${liked?"♥":"♡"}</button>
      </div>
      <div class="product-info">
        <h3>${esc(p.name)}</h3>
        <div><span class="price">$${Number(p.price).toFixed(2)}</span>${Number(p.old)>0?`<span class="old-price">$${Number(p.old).toFixed(2)}</span>`:""}</div>
        ${currentUser?`<div class="commission">🟢 Earn $${Number(p.commission).toFixed(2)}</div>`:""}
        <button class="share-btn" type="button" data-action="share" data-id="${p.id}">🔗 ${currentUser?"Copy Affiliate Link":"View Product"}</button>
        ${canManage?`<div class="product-actions"><button class="edit-btn" data-action="edit" data-id="${p.id}">✏️ Edit</button><button class="delete-btn" data-action="delete" data-id="${p.id}">🗑️ Delete</button></div>`:`<div class="customer-only-note">👤 Customer view</div>`}
      </div>`;
    grid.appendChild(card);
  });
}

function renderShops() {
  const box = $("createdShops"); if (!box || !currentUser) return;
  const mine = shops.filter(s => s.ownerId === currentUser.id); box.innerHTML = "";
  if (!mine.length) {
    box.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:45px 20px"><div style="font-size:42px">🛍️</div><h3>Create your first AffiliShop</h3><p style="color:#777;margin:7px 0 18px">Free: 2 products</p><button class="primary-btn" id="emptyCreateShopBtn">＋ Create AffiliShop</button></div>`;
    $("emptyCreateShopBtn")?.addEventListener("click", openShopCreator); return;
  }
  mine.forEach(shop => {
    const limit = planLimit();
    const limitText = limit === Infinity ? "Unlimited" : limit;
    const card = document.createElement("div"); card.className = "created-shop-card";
    card.innerHTML = `
      <h3>${esc(shop.name)}</h3>
      <div class="shop-slug">affilishop/${esc(shop.slug)}</div>
      <p>${esc(shop.description||"My affiliate products")}</p>
      <div class="shop-meta"><span>📦 ${shop.products.length}/${limitText}</span><span>⭐ ${planName()}</span></div>
      <div class="shop-card-actions">
        <button class="manage-shop-btn" data-shop-action="manage" data-id="${shop.id}">Manage</button>
        <button class="view-shop-btn" data-shop-action="view" data-id="${shop.id}">View Shop</button>
        <button class="remove-shop-btn" data-shop-action="delete" data-id="${shop.id}">Delete</button>
      </div>`;
    box.appendChild(card);
  });
}

function renderPublicShops() {
  const box = $("publicShopsGrid"); if (!box) return; box.innerHTML = "";
  if (!shops.length) {
    box.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:30px"><h3>No shops yet</h3><p style="color:#777;margin-top:7px">Sign in to create one.</p></div>`; return;
  }
  shops.forEach(shop => {
    const card = document.createElement("div"); card.className = "public-creator-card";
    card.innerHTML = `<h3>🛍️ ${esc(shop.name)}</h3><div class="public-creator-meta">${shop.products.length} product${shop.products.length===1?"":"s"}</div><p>${esc(shop.description||"Browse products")}</p><button class="public-visit-btn" data-public-shop="${shop.id}">Visit Shop →</button>`;
    box.appendChild(card);
  });
}

function updateAccess() {
  const logged = !!currentUser;
  $("shop")?.classList.remove("hidden");
  $("dashboard")?.classList.toggle("hidden", !logged);
  $("myShops")?.classList.toggle("hidden", !logged);
  $("shopLocked")?.classList.remove("hidden");
  $("shopOwnerActions")?.classList.toggle("hidden", !logged);
  $("shopSubtitle").textContent = logged ? "Manage your shop products" : "Browse products — no sign-in needed";
  updateAccount(); updateStats(); renderShops(); renderPublicShops(); renderProducts();
}

function bind() {
  $("loginButton")?.addEventListener("click", () => openModal("loginModal"));
  $("signupButton")?.addEventListener("click", () => openModal("signupModal"));
  $("logoutButton")?.addEventListener("click", logout);
  $("lockedSignupBtn")?.addEventListener("click", () => openModal("signupModal"));
  $("lockedLoginBtn")?.addEventListener("click", () => openModal("loginModal"));
  $("addProductBtn")?.addEventListener("click", () => {
    if (!currentUser) { openModal("signupModal"); toast("Sign up first."); return; }
    if (!getActiveShop()) { openShopCreator(); return; }
    openProductForm();
  });
  $("createShopBtn")?.addEventListener("click", openShopCreator);
  $("createShopBtn2")?.addEventListener("click", openShopCreator);
  $("saveShopBtn")?.addEventListener("click", saveShop);
  $("openPlansBtn")?.addEventListener("click", openPlans);
  $("loginSubmit")?.addEventListener("click", login);
  $("signupSubmit")?.addEventListener("click", signup);
  $("forgotButton")?.addEventListener("click", startReset);
  $("verifyResetBtn")?.addEventListener("click", verifyReset);
  $("resetPasswordBtn")?.addEventListener("click", resetPassword);
  $("saveProductBtn")?.addEventListener("click", saveProduct);
  $("resetStatsBtn")?.addEventListener("click", resetStats);
  $("darkButton")?.addEventListener("click", () => {
    document.body.classList.toggle("dark");
    localStorage.setItem(KEY.dark, document.body.classList.contains("dark") ? "1" : "0");
  });
  $("toSignup")?.addEventListener("click", () => { closeModals(); openModal("signupModal"); });
  $("toLogin")?.addEventListener("click", () => { closeModals(); openModal("loginModal"); });
  $("forgotToLogin")?.addEventListener("click", () => { closeModals(); openModal("loginModal"); });
  $("searchInput")?.addEventListener("input", renderProducts);

  document.querySelectorAll(".category-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.preventDefault();
      document.querySelectorAll(".category-btn").forEach(x => x.classList.remove("active"));
      btn.classList.add("active");
      category = (btn.dataset.category || "all").toLowerCase();
      renderProducts();
    });
  });

  document.querySelectorAll("[data-plan]").forEach(btn => {
    btn.addEventListener("click", () => choosePlan(btn.dataset.plan));
  });

  document.querySelectorAll("[data-close-modal]").forEach(b => b.addEventListener("click", closeModals));
  document.querySelectorAll(".modal").forEach(m => m.addEventListener("click", e => { if (e.target === m) closeModals(); }));

  $("productGrid")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-action]");
    if (btn) {
      const id = btn.dataset.id;
      if (btn.dataset.action === "favorite") {
        const n = Number(id);
        favorites = favorites.includes(n) ? favorites.filter(x => x !== n) : [...favorites, n];
        write(KEY.favorites, favorites); renderProducts();
      }
      if (btn.dataset.action === "share") shareProduct(id);
      if (btn.dataset.action === "edit") {
        const shop = getActiveShop();
        if (!shop || !shop.products.some(p => p.id === Number(id))) return toast("Cannot edit.");
        openProductForm(products.find(p => p.id === Number(id)));
      }
      if (btn.dataset.action === "delete") {
        const shop = getActiveShop();
        if (!shop || !shop.products.some(p => p.id === Number(id))) return toast("Cannot delete.");
        deleteProduct(id);
      }
    } else {
      const card = e.target.closest("[data-product-view]");
      if (card) viewPublicProduct(card.dataset.productView);
    }
  });

  $("createdShops")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-shop-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.shopAction === "manage") manageShop(id);
    if (btn.dataset.shopAction === "view") viewShop(id);
    if (btn.dataset.shopAction === "delete") deleteShop(id);
  });

  $("publicShopsGrid")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-public-shop]");
    if (btn) viewShop(btn.dataset.publicShop);
  });

  $("publicShopProducts")?.addEventListener("click", e => {
    const link = e.target.closest("[data-public-link]");
    if (link) { stats.clicks += 1; write(KEY.stats, stats); updateStats(); }
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeModals();
    if (e.key === "Enter" && $("loginModal")?.classList.contains("show")) login();
  });
}

async function init() {
  if (localStorage.getItem(KEY.dark) === "1") document.body.classList.add("dark");
  
  // Initialize data
  products = read(KEY.products, null);
  if (!Array.isArray(products)) {
    products = DEFAULT_PRODUCTS.map((p, i) => ({
      id: i + 1, name: p[0], category: p[1], price: p[2], old: p[3],
      commission: p[4], badge: p[5], image: p[6], affiliate: p[7]
    }));
    write(KEY.products, products);
  }
  favorites = read(KEY.favorites, []);
  shops = read(KEY.shops, []);
  stats = read(KEY.stats, { clicks: 0, shared: 0, commission: 0 });
  currentPlan = localStorage.getItem(KEY.plan) || "free";

  await restoreServerSession();
  bind();
  updateAuth();
  updateAccess();
}

document.addEventListener("DOMContentLoaded", () => {
  const monthlyBtn = document.getElementById("monthlyPlanBtn");
  const yearlyBtn = document.getElementById("yearlyPlanBtn");
  const lifetimeBtn = document.getElementById("lifetimePlanBtn");
  monthlyBtn?.addEventListener("click", () => choosePlan("monthly"));
  yearlyBtn?.addEventListener("click", () => choosePlan("yearly"));
  lifetimeBtn?.addEventListener("click", () => choosePlan("lifetime"));
  init();
});

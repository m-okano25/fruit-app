const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: CORS_HEADERS,
  });
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function canonicalProductKey(value) {
  return String(value || "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[✕×xX]\s*\d+[箱個玉ケースkgKG㎏]*/gi, "")
    .replace(/\s+/g, "")
    .replace(/[（）()【】\[\]・･]/g, "")
    .toLowerCase();
}

function saleId(sale) {
  return String(sale?.id || `${sale?.date || ""}-${sale?.productName || ""}-${sale?.platform || ""}-${sale?.price || ""}-${Math.random()}`);
}

function productKey(product) {
  return normalizeKey(product?.name || product?.productName || product?.id);
}

function inventoryKey(item) {
  return normalizeKey(item?.productName || item?.name || item?.id);
}

function historyId(item) {
  return String(item?.id || `${item?.date || ""}-${item?.productName || ""}-${item?.type || ""}-${Math.random()}`);
}

async function readTable(db, tableName) {
  const result = await db.prepare(`SELECT data FROM ${tableName}`).all();
  return (result.results || []).map((row) => JSON.parse(row.data));
}

async function getAllData(db) {
  const [sales, products, inventory, stockHistory, deletedProductsRow, deletedInventoryRow] = await Promise.all([
    readTable(db, "sales"),
    readTable(db, "products"),
    readTable(db, "inventory"),
    readTable(db, "stock_history"),
    db.prepare("SELECT value FROM sync_meta WHERE key = 'deleted_product_keys'").first(),
    db.prepare("SELECT value FROM sync_meta WHERE key = 'deleted_inventory_keys'").first(),
  ]);

  const parseKeys = (row) => {
    try { return JSON.parse(row?.value || "[]"); } catch { return []; }
  };
  return {
    sales, products, inventory, stockHistory,
    deletedProductKeys: parseKeys(deletedProductsRow),
    deletedInventoryKeys: parseKeys(deletedInventoryRow),
    syncVersion: 2,
  };
}

async function replaceTable(db, tableName, keyColumn, rows) {
  const statements = [db.prepare(`DELETE FROM ${tableName}`)];
  for (const row of rows) {
    const key = keyColumn(row);
    if (!key) continue;
    statements.push(
      db.prepare(`INSERT INTO ${tableName} (id, data, updated_at) VALUES (?, ?, datetime('now'))`)
        .bind(key, JSON.stringify(row))
    );
  }
  return statements;
}

async function replaceKeyedTable(db, tableName, keyColumn, rows) {
  const statements = [db.prepare(`DELETE FROM ${tableName}`)];
  for (const row of rows) {
    const key = keyColumn(row);
    if (!key) continue;
    statements.push(
      db.prepare(`INSERT INTO ${tableName} (key, data, updated_at) VALUES (?, ?, datetime('now'))`)
        .bind(key, JSON.stringify(row))
    );
  }
  return statements;
}

async function saveAllData(db, data) {
  const sales = Array.isArray(data.sales) ? data.sales : [];
  let products = Array.isArray(data.products) ? data.products : [];
  let inventory = Array.isArray(data.inventory) ? data.inventory : [];
  const stockHistory = Array.isArray(data.stockHistory) ? data.stockHistory : [];

  // v2端末は削除一覧を正式データとして更新。旧端末はサーバーの削除情報を維持する。
  const [storedProductDeletes, storedInventoryDeletes] = await Promise.all([
    db.prepare("SELECT value FROM sync_meta WHERE key = 'deleted_product_keys'").first(),
    db.prepare("SELECT value FROM sync_meta WHERE key = 'deleted_inventory_keys'").first(),
  ]);
  const parseKeys = (row) => {
    try { return JSON.parse(row?.value || "[]"); } catch { return []; }
  };
  const isV2 = Number(data.syncVersion) >= 2;
  const deletedProductKeys = isV2 && Array.isArray(data.deletedProductKeys)
    ? data.deletedProductKeys : parseKeys(storedProductDeletes);
  const deletedInventoryKeys = isV2 && Array.isArray(data.deletedInventoryKeys)
    ? data.deletedInventoryKeys : parseKeys(storedInventoryDeletes);
  const deletedProducts = new Set(deletedProductKeys);
  const deletedInventory = new Set(deletedInventoryKeys);
  products = products.filter((item) => !deletedProducts.has(canonicalProductKey(item?.name || item?.productName)));
  inventory = inventory.filter((item) => !deletedInventory.has(canonicalProductKey(item?.productName || item?.name)));

  const current = await db.prepare("SELECT COUNT(*) AS count FROM sales").first();
  const currentSalesCount = current?.count || 0;

  if (sales.length < currentSalesCount) {
    return {
      success: false,
      rejected: true,
      reason: `クラウド側の売上${currentSalesCount}件より少ない売上${sales.length}件のため、上書きを拒否しました。`,
      cloudSales: currentSalesCount,
      receivedSales: sales.length,
    };
  }

  const statements = [
    ...(await replaceTable(db, "sales", saleId, sales)),
    ...(await replaceKeyedTable(db, "products", productKey, products)),
    ...(await replaceKeyedTable(db, "inventory", inventoryKey, inventory)),
    ...(await replaceTable(db, "stock_history", historyId, stockHistory)),
    db.prepare(
      "INSERT OR REPLACE INTO sync_meta (key, value, updated_at) VALUES ('last_sync', ?, datetime('now'))"
    ).bind(new Date().toISOString()),
    db.prepare(
      "INSERT OR REPLACE INTO sync_meta (key, value, updated_at) VALUES ('deleted_product_keys', ?, datetime('now'))"
    ).bind(JSON.stringify(deletedProductKeys)),
    db.prepare(
      "INSERT OR REPLACE INTO sync_meta (key, value, updated_at) VALUES ('deleted_inventory_keys', ?, datetime('now'))"
    ).bind(JSON.stringify(deletedInventoryKeys)),
  ];

  await db.batch(statements);

  return {
    success: true,
    savedSales: sales.length,
    savedProducts: products.length,
    savedInventory: inventory.length,
    savedStockHistory: stockHistory.length,
    deletedProductKeys,
    deletedInventoryKeys,
    timestamp: new Date().toISOString(),
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (!env.DB) {
      return jsonResponse({ success: false, error: "D1 DB binding is missing" }, 500);
    }

    const url = new URL(request.url);

    try {
      if (request.method === "GET") {
        if (url.pathname === "/health") {
          const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM sales").first();
          return jsonResponse({ ok: true, sales: count?.count || 0 });
        }

        return jsonResponse(await getAllData(env.DB));
      }

      if (request.method === "POST") {
        const data = await request.json();
        const result = await saveAllData(env.DB, data);
        return jsonResponse(result, result.success ? 200 : 409);
      }

      return jsonResponse({ success: false, error: "Method not allowed" }, 405);
    } catch (error) {
      return jsonResponse({ success: false, error: String(error?.message || error) }, 500);
    }
  },
};

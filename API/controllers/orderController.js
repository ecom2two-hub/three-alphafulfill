const { createOrder, getAllOrders, getAllOrdersForExport, saveShipeasoResponse, getOrderById, getOrdersByCustomerId, updateOrderStatus } = require('../models/orderModel');
const AbandonCheckout = require('../models/abandonCheckoutModel');
const axios = require('axios');
const db    = require('../config/db');

// ── Fetch product SKU + variants for a product id ─────────────────────────────
async function getProductData(productId) {
    try {
        const [rows] = await db.execute('SELECT sku, variants FROM products WHERE id = ? LIMIT 1', [productId]);
        if (!rows[0]) return { sku: null, variants: [] };
        let variants = [];
        try { variants = rows[0].variants ? JSON.parse(rows[0].variants) : []; } catch {}
        return { sku: rows[0].sku || null, variants };
    } catch { return { sku: null, variants: [] }; }
}

// ── Shipeaso: push order to fulfillment partner ───────────────────────────────
async function pushToShipeaso(orderId, order, items) {
    const LOG = (msg, data) => console.log(`[Shipeaso][Order ${orderId}] ${msg}`, data !== undefined ? JSON.stringify(data) : '');

    let payload = null; // declared outside try so catch can access it

    try {
        const apiUrl = 'https://superadmin.shipeaso.com/api/order/non-shopify-create-orders';

        // Parse delivery address (comes as JSON string from DB)
        let address = {};
        try {
            address = typeof order.deliveryAddress === 'string'
                ? JSON.parse(order.deliveryAddress)
                : (order.deliveryAddress || {});
        } catch (e) {
            LOG('Address parse error', e.message);
        }

        // Build line_items — resolve SKU: variant option SKU > product SKU > product id
        const lineItems = await Promise.all(items.map(async (item) => {
            const productData = await getProductData(item.id);
            let skuCode = null;

            // Check if a variant option has its own SKU matching the selected options
            if (item.selectedOptions && Object.keys(item.selectedOptions).length > 0 && productData.variants?.length) {
                for (const variant of productData.variants) {
                    const selectedLabel = item.selectedOptions[variant.name];
                    if (selectedLabel) {
                        const matchedOpt = variant.options?.find(o => o.label === selectedLabel);
                        if (matchedOpt?.sku) { skuCode = matchedOpt.sku; break; }
                    }
                }
            }

            // Fallback to product-level SKU, then product id
            if (!skuCode) skuCode = productData.sku || String(item.id);

            LOG(`Item ${item.id} (${item.name}) → SKU: ${skuCode}`, { selectedOptions: item.selectedOptions });

            return {
                sku_code:       skuCode,
                price:          String(item.salePrice ?? item.price ?? 0),
                quantity:       item.quantity || 1,
                total_discount: 0
            };
        }));

        const customerName = order.guestName
            || `${order.firstName || ''} ${order.lastName || ''}`.trim()
            || 'Customer';

        payload = {
            order_id:          order.orderNumber,
            shop_domain:       'one.alphafulfill.online',
            customer_email:    order.guestEmail || order.email || '',
            customer_name:     customerName,
            customer_mobileno: order.contactPhone || '',
            address_line_one:  address.line1    || '',
            address_line_two:  address.landmark || address.city || '',
            pincode:           String(address.postcode || ''),
            city:              address.city     || '',
            state:             address.state    || '',
            payment_type:      (order.paymentMethod || 'cod').toUpperCase() === 'COD' ? 'COD' : 'PREPAID',
            line_items:        lineItems
        };

        LOG('Sending payload', payload);

        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });

        LOG('SUCCESS', response.data);
        await saveShipeasoResponse(orderId, JSON.stringify({ request: payload, response: response.data }));

    } catch (err) {
        const errData = err.response
            ? { status: err.response.status, data: err.response.data }
            : { message: err.message };
        console.error(`[Shipeaso][Order ${orderId}] ERROR`, JSON.stringify(errData));
        // Save request + error so admin can see what was sent
        try { await saveShipeasoResponse(orderId, JSON.stringify({ request: payload, error: errData })); } catch {}
    }
}

async function create(req, res) {
    try {
        const data = req.body;
        if (!data.items || !data.total) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        data.orderNumber = `ORD-${Date.now()}`;
        const id = await createOrder(data);
        const order = await getOrderById(id);

        if (data.sessionId) {
            try { await AbandonCheckout.markConverted(data.sessionId, id); } catch {}
        }

        // Fire Shipeaso push async — does NOT block the response
        // Pass order from DB (has orderNumber, contactPhone etc) + raw items from request (has id, price, sku)
        setImmediate(() => pushToShipeaso(id, order, data.items || []));

        res.json({ success: true, data: order });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

async function getAll(req, res) {
    try {
        const page   = parseInt(req.query.page)  || 1;
        const limit  = parseInt(req.query.limit) || 20;
        const filters = {
            status:        req.query.status        || '',
            search:        req.query.search        || '',
            dateFrom:      req.query.dateFrom      || '',
            dateTo:        req.query.dateTo        || '',
            paymentMethod: req.query.paymentMethod || ''
        };
        const result = await getAllOrders(page, limit, filters);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

async function getById(req, res) {
    try {
        const order = await getOrderById(req.params.id);
        if (!order) return res.status(404).json({ error: 'Order not found' });
        res.json({ data: order });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

async function getByCustomer(req, res) {
    try {
        const orders = await getOrdersByCustomerId(req.params.customerId);
        res.json({ data: orders });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

async function updateStatus(req, res) {
    try {
        const { status } = req.body;
        const order = await updateOrderStatus(req.params.id, status);
        res.json({ success: true, data: order });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

async function exportCSV(req, res) {
    try {
        const filters = {
            status:        req.query.status        || '',
            search:        req.query.search        || '',
            dateFrom:      req.query.dateFrom      || '',
            dateTo:        req.query.dateTo        || '',
            paymentMethod: req.query.paymentMethod || ''
        };

        const rows = await getAllOrdersForExport(filters);

        const headers = [
            'Order #', 'Order Date', 'Status',
            'Customer Name', 'Phone', 'Email',
            'Payment Method', 'Payment ID',
            'Items Summary', 'Items Detail',
            'Subtotal', 'Delivery Charge', 'Grand Total',
            'Address', 'Landmark', 'City', 'State', 'Pincode'
        ];

        const tryParse = (val, fallback) => {
            try { return typeof val === 'string' ? JSON.parse(val) : (val ?? fallback); }
            catch { return fallback; }
        };

        const csvRows = rows.map(o => {
            const items   = tryParse(o.items, []);
            const address = tryParse(o.deliveryAddress, null);
            const name    = `${o.firstName || ''} ${o.lastName || ''}`.trim() || o.guestName || '';

            const itemsSummary = items.map(i => `${i.name} x${i.quantity}`).join(' | ');
            const itemsDetail  = items.map(i => {
                const opts  = Object.entries(i.selectedOptions || {}).map(([k, v]) => `${k}:${v}`).join(',');
                const price = ((i.salePrice ?? i.price) * i.quantity).toFixed(2);
                return `${i.name}${opts ? ' ('+opts+')' : ''} x${i.quantity} = ${price}`;
            }).join(' | ');

            return [
                o.orderNumber,
                new Date(o.created_at).toLocaleString('en-IN'),
                o.status,
                name,
                o.contactPhone || '',
                o.email || o.guestEmail || '',
                o.paymentMethod || '',
                o.razorpayPaymentId || o.paymentId || '',
                itemsSummary,
                itemsDetail,
                o.subtotal,
                o.deliveryCharge,
                o.total,
                address?.line1 || '',
                address?.landmark || '',
                address?.city || '',
                address?.state || '',
                address?.postcode || ''
            ];
        });

        const csv = [headers, ...csvRows]
            .map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
            .join('\n');

        const filename = `orders_${new Date().toISOString().split('T')[0]}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send('\uFEFF' + csv); // BOM for Excel UTF-8
    } catch (err) {
        console.error('exportCSV:', err);
        res.status(500).json({ error: err.message });
    }
}

module.exports = { create, getAll, getById, getByCustomer, updateStatus, exportCSV };

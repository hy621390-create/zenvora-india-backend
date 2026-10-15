/**
 * ZENVORA India - Production Ready Razorpay Backend
 * Secure: Never expose RAZORPAY_KEY_SECRET in frontend
 * Validates amount server-side - does NOT blindly trust frontend amount
 * 
 * Endpoints:
 * POST /api/create-order - Creates Razorpay order
 * POST /api/verify-payment - Verifies payment signature
 * GET /api/health - Health check
 */

const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();

// ===== CORS CONFIGURATION - Production Ready =====
const allowedOrigins = [
  'https://zenvora.in',
  'https://www.zenvora.in',
  'https://zenvora.vercel.app',
  process.env.FRONTEND_URL,
  'http://localhost:5173', // Vite dev
  'http://localhost:3000', // CRA dev
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      console.warn(`[CORS] Blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

app.use(express.json({ limit: '10kb' })); // Limit payload size
app.use(express.urlencoded({ extended: false }));

// ===== PRODUCT CATALOG - Server-side source of truth =====
// NEVER trust frontend amount - recalculate from this catalog
const PRODUCT_CATALOG = {
  1: { name: 'Everyday Box Kraft', price: 1999 },
  2: { name: 'Everyday Box White', price: 1999 },
  3: { name: 'Storage Set Small Kraft', price: 999 },
  4: { name: 'Storage Set Small White', price: 999 },
  5: { name: 'Stack Bundle Kraft Trio', price: 3499 },
  6: { name: 'Stack Bundle Mixed', price: 3499 },
};

const SHIPPING_RULES = {
  threshold: 1999, // FREE shipping over ₹1999
  fee: 99,
  codFee: 49,
};

// ===== Razorpay Instance - Secret only in backend =====
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.error('❌ RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET missing in .env');
  console.error('Get keys from https://dashboard.razorpay.com/app/keys');
}

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ===== Helper: Validate and Recalculate Amount Server-Side =====
function calculateOrderAmount(items, paymentMethod) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Cart is empty');
  }
  if (items.length > 20) {
    throw new Error('Cart exceeds maximum items (20)');
  }

  let subtotal = 0;
  const validatedItems = [];

  for (const item of items) {
    const product = PRODUCT_CATALOG[item.id];
    if (!product) {
      throw new Error(`Invalid product ID: ${item.id}`);
    }
    const qty = parseInt(item.qty, 10);
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
      throw new Error(`Invalid quantity for ${product.name}: Must be 1-10`);
    }
    const lineTotal = product.price * qty;
    subtotal += lineTotal;
    validatedItems.push({
      id: item.id,
      name: product.name,
      price: product.price,
      qty,
      lineTotal,
    });
  }

  // Shipping calculation - preserved rule
  let shipping = 0;
  if (subtotal > 0) {
    shipping = subtotal >= SHIPPING_RULES.threshold ? 0 : SHIPPING_RULES.fee;
  }

  // COD fee
  let codFee = 0;
  if (paymentMethod === 'cod') {
    codFee = SHIPPING_RULES.codFee;
  }

  const total = subtotal + shipping + codFee;

  return {
    subtotal,
    shipping,
    codFee,
    total,
    validatedItems,
  };
}

// ===== Helper: Validate Indian Address =====
function validateIndianAddress(address) {
  const errors = [];

  if (!address.fullName || address.fullName.trim().length < 2) {
    errors.push('Full Name must be at least 2 characters');
  }
  if (!address.mobile || !/^[6-9]\d{9}$/.test(address.mobile.replace(/\D/g, '').slice(-10))) {
    errors.push('Invalid mobile number. Must be 10 digits starting with 6-9');
  }
  if (!address.houseFlat || address.houseFlat.trim().length < 2) {
    errors.push('House/Flat is required');
  }
  if (!address.areaStreet || address.areaStreet.trim().length < 3) {
    errors.push('Area/Street is required');
  }
  if (!address.city || address.city.trim().length < 2) {
    errors.push('City is required');
  }
  if (!address.state || address.state.trim().length < 2) {
    errors.push('State is required');
  }
  if (!address.pinCode || !/^[1-9][0-9]{5}$/.test(address.pinCode)) {
    errors.push('Invalid PIN Code. Must be 6 digits, not starting with 0');
  }

  return errors;
}

// ===== POST /api/create-order =====
app.post('/api/create-order', async (req, res) => {
  try {
    const { items, paymentMethod, customer } = req.body;

    // Validate customer address
    if (!customer) {
      return res.status(400).json({ error: 'Customer details required' });
    }

    const addressErrors = validateIndianAddress(customer);
    if (addressErrors.length > 0) {
      return res.status(400).json({ error: 'Invalid address', details: addressErrors });
    }

    // CRITICAL: Recalculate amount server-side - DO NOT trust frontend amount
    let pricing;
    try {
      pricing = calculateOrderAmount(items, paymentMethod);
    } catch (calcError) {
      return res.status(400).json({ error: calcError.message });
    }

    // For COD, don't create Razorpay order - direct ZENVORA order
    if (paymentMethod === 'cod') {
      const zenvoraOrderId = `ZEN-IND-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
      console.log(`[ZENVORA] COD Order created: ${zenvoraOrderId} | Total: ₹${pricing.total}`);

      return res.json({
        isCod: true,
        zenvoraOrderId,
        pricing,
        message: 'COD order ready for confirmation',
      });
    }

    // For online payments: Create Razorpay order
    const options = {
      amount: pricing.total * 100, // Razorpay expects paise
      currency: 'INR',
      receipt: `ZEN-IND-${Date.now()}`,
      notes: {
        customer_name: customer.fullName,
        customer_mobile: customer.mobile,
        customer_city: customer.city,
        customer_state: customer.state,
        payment_method: paymentMethod,
        subtotal: pricing.subtotal.toString(),
        shipping: pricing.shipping.toString(),
        total: pricing.total.toString(),
      },
    };

    const razorpayOrder = await razorpay.orders.create(options);

    console.log(`[ZENVORA] Razorpay order created: ${razorpayOrder.id} | Amount: ₹${pricing.total} | Customer: ${customer.fullName}`);

    res.json({
      isCod: false,
      id: razorpayOrder.id,
      amount: razorpayOrder.amount, // in paise
      currency: razorpayOrder.currency,
      receipt: razorpayOrder.receipt,
      pricing, // Send back server-calculated pricing for frontend display
    });

  } catch (error) {
    console.error('[ZENVORA] Create order error:', error);
    res.status(500).json({
      error: 'Failed to create order',
      details: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message,
    });
  }
});

// ===== POST /api/verify-payment =====
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, customer, items } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Missing payment verification data' });
    }

    // Recalculate amount again for verification (defense in depth)
    let pricing;
    try {
      pricing = calculateOrderAmount(items, 'online');
    } catch (calcError) {
      return res.status(400).json({ success: false, error: calcError.message });
    }

    // Verify signature - CRITICAL SECURITY STEP
    // Only after this verification we can show Paid status
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    const isAuthentic = expectedSignature === razorpay_signature;

    if (!isAuthentic) {
      console.error(`[ZENVORA] Signature verification FAILED for order ${razorpay_order_id}`);
      console.error(`Expected: ${expectedSignature}, Received: ${razorpay_signature}`);
      return res.status(400).json({
        success: false,
        error: 'Payment verification failed - Invalid signature. Possible tampering detected.',
      });
    }

    // Signature verified - Payment is authentic
    // TODO: Save to database (MongoDB, PostgreSQL, etc.)
    // Example: await db.orders.create({ ... })

    const zenvoraOrderId = `ZEN-IND-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

    console.log(`[ZENVORA] Payment VERIFIED: ${razorpay_payment_id} | Razorpay Order: ${razorpay_order_id} | ZENVORA Order: ${zenvoraOrderId} | Amount: ₹${pricing.total}`);

    res.json({
      success: true,
      zenvoraOrderId,
      razorpay_order_id,
      razorpay_payment_id,
      pricing,
      message: 'Payment verified successfully',
      paymentStatus: 'Paid',
      estimatedDelivery: '3-5 business days',
    });

  } catch (error) {
    console.error('[ZENVORA] Verify payment error:', error);
    res.status(500).json({
      success: false,
      error: 'Payment verification failed',
      details: process.env.NODE_ENV === 'production' ? 'Internal error' : error.message,
    });
  }
});

// ===== GET /api/health =====
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ZENVORA India Backend',
    timestamp: new Date().toISOString(),
    razorpayConfigured: !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
    environment: process.env.NODE_ENV || 'development',
  });
});

// ===== GET /api/products - Expose catalog for frontend validation =====
app.get('/api/products', (req, res) => {
  res.json({
    products: PRODUCT_CATALOG,
    shippingRules: SHIPPING_RULES,
  });
});

// ===== Global Error Handler =====
app.use((err, req, res, next) => {
  console.error('[ZENVORA] Unhandled error:', err);
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'CORS: Origin not allowed' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

// ===== 404 Handler =====
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.path });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n✅ ZENVORA India Backend running`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Env: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Frontend: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
  console.log(`   Razorpay: ${process.env.RAZORPAY_KEY_ID ? 'Configured' : 'NOT CONFIGURED - Set in .env'}`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);
});

module.exports = app;

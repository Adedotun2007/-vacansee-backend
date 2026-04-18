require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, PutCommand, ScanCommand,
  GetCommand, UpdateCommand, DeleteCommand
} = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ─── AWS + Claude setup ────────────────────────────
const s3 = new S3Client({ region: process.env.AWS_REGION });
const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── S3 upload middleware ──────────────────────────
const uploadMiddleware = multer({
  storage: multerS3({
    s3, bucket: process.env.S3_BUCKET,
    key: (req, file, cb) =>
      cb(null, `vacansee/${uuidv4()}-${file.originalname}`)
  })
}).array('photos', 10);

const uploadSingle = multer({
  storage: multerS3({
    s3, bucket: process.env.S3_BUCKET,
    key: (req, file, cb) =>
      cb(null, `vacansee/profiles/${uuidv4()}-${file.originalname}`)
  })
}).single('profilePhoto');

// ─── Helpers ──────────────────────────────────────
const safeNum = (val, fallback = 0) => {
  const n = Number(val);
  return isNaN(n) ? fallback : n;
};

function generatePIN() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let pin = 'FUTA-';
  for (let i = 0; i < 6; i++) pin += chars[Math.floor(Math.random() * chars.length)];
  return pin;
}

function hashPassword(password) {
  return crypto.createHash('sha256')
    .update(password + 'vacansee_salt_2025').digest('hex');
}

// ─── ROUTE 1: Health check ────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'VacanSee V2 API running!', version: '2.0' });
});

// ─── ADMIN PIN ROUTES ─────────────────────────────

app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/api/admin/generate-pin', async (req, res) => {
  const { email, password } = req.body;
  if (email !== process.env.ADMIN_EMAIL || password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Unauthorized' });
  try {
    const pin = generatePIN();
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    await dynamo.send(new PutCommand({
      TableName: 'AdminPins',
      Item: { pin, used: false, createdAt: new Date().toISOString(), expiresAt }
    }));
    res.json({ success: true, pin, expiresAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/list-pins', async (req, res) => {
  const { email, password } = req.body;
  if (email !== process.env.ADMIN_EMAIL || password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await dynamo.send(new ScanCommand({ TableName: 'AdminPins' }));
    const pins = (result.Items || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ pins });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/validate-pin', async (req, res) => {
  const { pin } = req.body;
  try {
    const result = await dynamo.send(new GetCommand({ TableName: 'AdminPins', Key: { pin } }));
    if (!result.Item) return res.json({ valid: false, reason: 'PIN does not exist' });
    if (result.Item.used) return res.json({ valid: false, reason: 'PIN already used' });
    if (new Date(result.Item.expiresAt) < new Date()) return res.json({ valid: false, reason: 'PIN expired' });
    res.json({ valid: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── LANDLORD AUTH ────────────────────────────────

app.post('/api/landlord/signup', (req, res) => {
  uploadSingle(req, res, async (err) => {
    if (err) return res.status(500).json({ error: 'Photo upload failed: ' + err.message });
    const { name, email, password, phone, whatsapp, bio, pin } = req.body;
    try {
      const pinRecord = await dynamo.send(new GetCommand({ TableName: 'AdminPins', Key: { pin } }));
      if (!pinRecord.Item || pinRecord.Item.used || new Date(pinRecord.Item.expiresAt) < new Date())
        return res.status(400).json({ error: 'Invalid or expired PIN. Contact vacansee@gmail.com for a new one.' });

      const existing = await dynamo.send(new ScanCommand({
        TableName: 'LandlordProfiles',
        FilterExpression: 'email = :e',
        ExpressionAttributeValues: { ':e': email }
      }));
      if (existing.Items && existing.Items.length > 0)
        return res.status(400).json({ error: 'Account with this email already exists' });

      const landlordId = uuidv4();
      const profilePhotoUrl = req.file ? req.file.location : '';
      await dynamo.send(new PutCommand({
        TableName: 'LandlordProfiles',
        Item: {
          landlordId, name, email,
          passwordHash: hashPassword(password),
          phone: phone || '', whatsapp: whatsapp || '',
          bio: bio || '', profilePhotoUrl,
          verified: true, createdAt: new Date().toISOString(),
          averageRating: 0, totalReviews: 0
        }
      }));
      await dynamo.send(new UpdateCommand({
        TableName: 'AdminPins', Key: { pin },
        UpdateExpression: 'set #u = :u, usedBy = :e, usedAt = :t',
        ExpressionAttributeNames: { '#u': 'used' },
        ExpressionAttributeValues: { ':u': true, ':e': email, ':t': new Date().toISOString() }
      }));
      res.json({ success: true, landlordId, name, email });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
});

app.post('/api/landlord/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await dynamo.send(new ScanCommand({
      TableName: 'LandlordProfiles',
      FilterExpression: 'email = :e AND passwordHash = :p',
      ExpressionAttributeValues: { ':e': email, ':p': hashPassword(password) }
    }));
    if (!result.Items || result.Items.length === 0)
      return res.status(401).json({ error: 'Invalid email or password' });
    const l = result.Items[0];
    res.json({ success: true, landlordId: l.landlordId, name: l.name, email: l.email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/landlord/:id', async (req, res) => {
  try {
    const result = await dynamo.send(new GetCommand({
      TableName: 'LandlordProfiles', Key: { landlordId: req.params.id }
    }));
    if (!result.Item) return res.status(404).json({ error: 'Landlord not found' });
    const { passwordHash, ...publicProfile } = result.Item;
    const listings = await dynamo.send(new ScanCommand({
      TableName: 'Apartments',
      FilterExpression: 'landlordId = :id',
      ExpressionAttributeValues: { ':id': req.params.id }
    }));
    res.json({ landlord: publicProfile, listings: listings.Items || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── TENANT AUTH ──────────────────────────────────

app.post('/api/tenant/signup', async (req, res) => {
  const { name, email, password, department, level } = req.body;
  try {
    const existing = await dynamo.send(new ScanCommand({
      TableName: 'Tenants',
      FilterExpression: 'email = :e',
      ExpressionAttributeValues: { ':e': email }
    }));
    if (existing.Items && existing.Items.length > 0)
      return res.status(400).json({ error: 'Account already exists with this email' });
    const tenantId = uuidv4();
    await dynamo.send(new PutCommand({
      TableName: 'Tenants',
      Item: { tenantId, name, email, passwordHash: hashPassword(password),
              department: department || '', level: level || '',
              createdAt: new Date().toISOString() }
    }));
    res.json({ success: true, tenantId, name, email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tenant/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await dynamo.send(new ScanCommand({
      TableName: 'Tenants',
      FilterExpression: 'email = :e AND passwordHash = :p',
      ExpressionAttributeValues: { ':e': email, ':p': hashPassword(password) }
    }));
    if (!result.Items || result.Items.length === 0)
      return res.status(401).json({ error: 'Invalid email or password' });
    const t = result.Items[0];
    res.json({ success: true, tenantId: t.tenantId, name: t.name, email: t.email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── APARTMENT ROUTES ──────────────────────────────

app.post('/api/apartments', (req, res) => {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    uploadMiddleware(req, res, (err) => {
      if (err) return res.status(500).json({ error: 'File upload failed: ' + err.message });
      handleApartmentSave(req, res);
    });
  } else {
    req.files = [];
    handleApartmentSave(req, res);
  }
});

async function handleApartmentSave(req, res) {
  try {
    const {
      title, location, zone, description, bedrooms, bathrooms, amenities,
      yearlyRent, cautionFee, agencyFee, agreementFee,
      landlordName, whatsapp, phone, email, landlordId, landlordSecret
    } = req.body;

    console.log('Apartment body:', JSON.stringify(req.body));

    if (!title)    return res.status(400).json({ error: 'title is required.' });
    if (!location) return res.status(400).json({ error: 'location is required.' });
    if (!yearlyRent || isNaN(Number(yearlyRent)))
      return res.status(400).json({ error: 'yearlyRent is required and must be a number.' });
    if (!bedrooms || isNaN(Number(bedrooms)))
      return res.status(400).json({ error: 'bedrooms is required and must be a number.' });
    if (!bathrooms || isNaN(Number(bathrooms)))
      return res.status(400).json({ error: 'bathrooms is required and must be a number.' });

    const imageUrls = (req.files || []).map(f => f.location);
    const parsedYearlyRent   = safeNum(yearlyRent);
    const parsedCautionFee   = safeNum(cautionFee);
    const parsedAgencyFee    = safeNum(agencyFee);
    const parsedAgreementFee = safeNum(agreementFee);
    const totalPackage = parsedYearlyRent + parsedCautionFee + parsedAgencyFee + parsedAgreementFee;

    let amenitiesList = [];
    if (Array.isArray(amenities)) amenitiesList = amenities;
    else if (typeof amenities === 'string' && amenities.trim())
      amenitiesList = amenities.split(',').map(a => a.trim());

    const apartment = {
      apartmentId: uuidv4(), title, location,
      zone: zone || 'Akure', description: description || '',
      bedrooms: safeNum(bedrooms), bathrooms: safeNum(bathrooms),
      amenities: amenitiesList,
      yearlyRent: parsedYearlyRent, cautionFee: parsedCautionFee,
      agencyFee: parsedAgencyFee, agreementFee: parsedAgreementFee,
      totalPackage,
      landlordName: landlordName || 'Landlord',
      whatsapp: whatsapp || '', phone: phone || '', email: email || '',
      landlordId: landlordId || '',
      landlordSecret: landlordSecret || '',
      imageUrls, available: true,
      averageRating: 0, totalReviews: 0,
      createdAt: new Date().toISOString()
    };

    await dynamo.send(new PutCommand({ TableName: 'Apartments', Item: apartment }));
    res.json({ success: true, apartment });
  } catch (err) {
    console.error('Save error:', err);
    res.status(500).json({ error: err.message });
  }
}

app.get('/api/apartments', async (req, res) => {
  try {
    const result = await dynamo.send(new ScanCommand({ TableName: 'Apartments' }));
    const sorted = (result.Items || [])
      .map(({ landlordSecret, ...rest }) => rest) // never expose secret
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ apartments: sorted });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/apartments/:id', async (req, res) => {
  try {
    const result = await dynamo.send(new GetCommand({
      TableName: 'Apartments', Key: { apartmentId: req.params.id }
    }));
    if (!result.Item) return res.status(404).json({ error: 'Not found' });
    const { landlordSecret, ...rest } = result.Item;
    const reviews = await dynamo.send(new ScanCommand({
      TableName: 'Reviews',
      FilterExpression: 'apartmentId = :id',
      ExpressionAttributeValues: { ':id': req.params.id }
    }));
    res.json({ apartment: rest, reviews: reviews.Items || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/apartments/:id/availability', async (req, res) => {
  try {
    const { available, landlordSecret } = req.body;
    const result = await dynamo.send(new GetCommand({
      TableName: 'Apartments', Key: { apartmentId: req.params.id }
    }));
    if (!result.Item) return res.status(404).json({ error: 'Not found.' });
    if (result.Item.landlordSecret && result.Item.landlordSecret !== landlordSecret)
      return res.status(403).json({ error: 'Invalid secret code.' });
    await dynamo.send(new UpdateCommand({
      TableName: 'Apartments', Key: { apartmentId: req.params.id },
      UpdateExpression: 'set available = :a',
      ExpressionAttributeValues: { ':a': available }
    }));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/apartments/:id', async (req, res) => {
  try {
    const { landlordSecret } = req.body;
    const result = await dynamo.send(new GetCommand({
      TableName: 'Apartments', Key: { apartmentId: req.params.id }
    }));
    if (!result.Item) return res.status(404).json({ error: 'Not found.' });
    if (result.Item.landlordSecret && result.Item.landlordSecret !== landlordSecret)
      return res.status(403).json({ error: 'Invalid secret code.' });
    await dynamo.send(new DeleteCommand({ TableName: 'Apartments', Key: { apartmentId: req.params.id } }));
    res.json({ success: true, message: 'Listing deleted.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── REVIEWS ──────────────────────────────────────

app.post('/api/reviews', async (req, res) => {
  const { apartmentId, tenantId, tenantName, rating, comment } = req.body;
  try {
    const existing = await dynamo.send(new ScanCommand({
      TableName: 'Reviews',
      FilterExpression: 'apartmentId = :a AND tenantId = :t',
      ExpressionAttributeValues: { ':a': apartmentId, ':t': tenantId }
    }));
    if (existing.Items && existing.Items.length > 0)
      return res.status(400).json({ error: 'You have already reviewed this apartment' });
    const reviewId = uuidv4();
    await dynamo.send(new PutCommand({
      TableName: 'Reviews',
      Item: { reviewId, apartmentId, tenantId, tenantName,
              rating: Number(rating), comment, createdAt: new Date().toISOString() }
    }));
    const allReviews = await dynamo.send(new ScanCommand({
      TableName: 'Reviews',
      FilterExpression: 'apartmentId = :a',
      ExpressionAttributeValues: { ':a': apartmentId }
    }));
    const avgRating = allReviews.Items.reduce((s, r) => s + r.rating, 0) / allReviews.Items.length;
    await dynamo.send(new UpdateCommand({
      TableName: 'Apartments', Key: { apartmentId },
      UpdateExpression: 'set averageRating = :r, totalReviews = :t',
      ExpressionAttributeValues: { ':r': Math.round(avgRating * 10) / 10, ':t': allReviews.Items.length }
    }));
    res.json({ success: true, reviewId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reviews/:apartmentId', async (req, res) => {
  try {
    const result = await dynamo.send(new ScanCommand({
      TableName: 'Reviews',
      FilterExpression: 'apartmentId = :id',
      ExpressionAttributeValues: { ':id': req.params.apartmentId }
    }));
    const sorted = (result.Items || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ reviews: sorted });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── AI ROUTES ────────────────────────────────────

app.post('/api/ai/recommend', async (req, res) => {
  try {
    const { budget, zone, bedrooms, preferences } = req.body;
    const listings = await dynamo.send(new ScanCommand({ TableName: 'Apartments' }));
    const listingText = listings.Items.filter(a => a.available).map(a =>
      `ID: ${a.apartmentId} | ${a.title} | ${a.location} (${a.zone}) | Yearly: ₦${a.yearlyRent?.toLocaleString()} | Total: ₦${a.totalPackage?.toLocaleString()} | ${a.bedrooms} bed | Rating: ${a.averageRating}/5 | Amenities: ${a.amenities?.join(', ')}`
    ).join('\n');
    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-5-20251001', max_tokens: 1000,
      messages: [{ role: 'user', content: `You are VacanSee AI for FUTA students in Akure. Budget: ₦${budget}/year, Zone: ${zone || 'anywhere near FUTA'}, Bedrooms: ${bedrooms}, Preferences: ${preferences || 'none'}.\n\nListings:\n${listingText}\n\nRecommend the best 3 options. Mention yearly pricing, ratings, and proximity to FUTA. Be friendly and concise. For help, direct students to vacansee@gmail.com.` }]
    });
    res.json({ recommendation: msg.content[0].text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    const listings = await dynamo.send(new ScanCommand({ TableName: 'Apartments' }));
    const listingText = listings.Items.filter(a => a.available).map(a =>
      `${a.title} at ${a.location} — ₦${a.yearlyRent?.toLocaleString()}/year, total ₦${a.totalPackage?.toLocaleString()}, ${a.bedrooms} bed, rating ${a.averageRating}/5, WhatsApp: ${a.whatsapp}`
    ).join('\n');
    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-5-20251001', max_tokens: 500,
      system: `You are VacanSee AI, a friendly housing assistant for FUTA (Federal University of Technology Akure) students. All prices are per year. For support or issues, direct students to vacansee@gmail.com.\n\nAvailable listings:\n${listingText}`,
      messages: [...(history || []), { role: 'user', content: message }]
    });
    res.json({ reply: msg.content[0].text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── START ────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ VacanSee V2 API running on port ${PORT}`));
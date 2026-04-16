require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, ScanCommand, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json());

// AWS + Claude setup
const s3 = new S3Client({ region: process.env.AWS_REGION });
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// S3 image upload config
const upload = multer({
  storage: multerS3({
    s3,
    bucket: process.env.S3_BUCKET,
    acl: 'public-read',
    key: (req, file, cb) => cb(null, `apartments/${uuidv4()}-${file.originalname}`)
  })
});

// ROUTE 1: Health check
app.get('/', (req, res) => {
  res.json({ status: 'VacanSee API is running!', app: 'VacanSee - FUTA Student Housing' });
});

// ROUTE 2: Upload new apartment listing (landlord)
app.post('/api/apartments', upload.array('photos', 10), async (req, res) => {
  try {
    const {
      title, location, zone, description,
      bedrooms, bathrooms, amenities,
      // Pricing
      monthlyRent, cautionFee, agencyFee, agreementFee,
      // Landlord contact
      landlordName, whatsapp, phone, email
    } = req.body;

    const imageUrls = req.files.map(f => f.location);

    // Calculate total move-in package
    const totalPackage =
      Number(monthlyRent) +
      Number(cautionFee || 0) +
      Number(agencyFee || 0) +
      Number(agreementFee || 0);

    const apartment = {
      apartmentId: uuidv4(),
      title,
      location,
      zone: zone || 'Akure',
      description,
      bedrooms: Number(bedrooms),
      bathrooms: Number(bathrooms),
      amenities: amenities ? amenities.split(',') : [],
      // Pricing breakdown
      monthlyRent: Number(monthlyRent),
      cautionFee: Number(cautionFee || 0),
      agencyFee: Number(agencyFee || 0),
      agreementFee: Number(agreementFee || 0),
      totalPackage,
      // Landlord contact
      landlordName: landlordName || 'Landlord',
      whatsapp: whatsapp || '',
      phone: phone || '',
      email: email || '',
      // Media + status
      imageUrls,
      available: true,
      createdAt: new Date().toISOString()
    };

    await dynamo.send(new PutCommand({ TableName: 'Apartments', Item: apartment }));
    res.json({ success: true, apartment });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ROUTE 3: Get all apartments (renter browse)
app.get('/api/apartments', async (req, res) => {
  try {
    const result = await dynamo.send(new ScanCommand({ TableName: 'Apartments' }));
    // Sort newest first
    const sorted = (result.Items || []).sort((a, b) =>
      new Date(b.createdAt) - new Date(a.createdAt)
    );
    res.json({ apartments: sorted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ROUTE 4: Get one apartment by ID
app.get('/api/apartments/:id', async (req, res) => {
  try {
    const result = await dynamo.send(new GetCommand({
      TableName: 'Apartments',
      Key: { apartmentId: req.params.id }
    }));
    res.json({ apartment: result.Item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ROUTE 5: Mark apartment as taken / available
app.patch('/api/apartments/:id/availability', async (req, res) => {
  try {
    const { available } = req.body;
    await dynamo.send(new UpdateCommand({
      TableName: 'Apartments',
      Key: { apartmentId: req.params.id },
      UpdateExpression: 'set available = :a',
      ExpressionAttributeValues: { ':a': available }
    }));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ROUTE 6: AI Recommendations (FUTA-aware)
app.post('/api/ai/recommend', async (req, res) => {
  try {
    const { budget, zone, bedrooms, preferences } = req.body;
    const listings = await dynamo.send(new ScanCommand({ TableName: 'Apartments' }));

    const listingText = listings.Items
      .filter(a => a.available)
      .map(a =>
        `ID: ${a.apartmentId} | ${a.title} | ${a.location} (${a.zone}) | Monthly: ₦${a.monthlyRent.toLocaleString()} | Total Package: ₦${a.totalPackage.toLocaleString()} | ${a.bedrooms} bed | Amenities: ${a.amenities?.join(', ')}`
      ).join('\n');

    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `You are VacanSee AI, a housing assistant for Federal University of Technology Akure (FUTA) students in Nigeria.

Student preferences:
- Monthly budget: ₦${budget}
- Preferred zone/area: ${zone || 'anywhere near FUTA'}
- Bedrooms needed: ${bedrooms}
- Other preferences: ${preferences || 'none specified'}

Available apartments near FUTA:
${listingText}

Recommend the top 3 best options for this FUTA student. For each, clearly state:
1. Why it suits this student (distance to FUTA, value for money, amenities)
2. Monthly rent AND total move-in package
3. Whether it's good for a solo student or shared accommodation

Be friendly, use Nigerian student language naturally. Mention if any place is close to specific FUTA gates.`
      }]
    });

    res.json({ recommendation: msg.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ROUTE 7: AI Chat
app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    const listings = await dynamo.send(new ScanCommand({ TableName: 'Apartments' }));

    const listingText = listings.Items
      .filter(a => a.available)
      .map(a =>
        `${a.title} at ${a.location} — ₦${a.monthlyRent?.toLocaleString()}/month, total package ₦${a.totalPackage?.toLocaleString()}, ${a.bedrooms} bed, WhatsApp: ${a.whatsapp}`
      ).join('\n');

    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: `You are VacanSee AI, a helpful housing assistant for FUTA (Federal University of Technology Akure) students in Nigeria.

Current available listings:
${listingText}

You help students find affordable rooms and apartments near FUTA. Be friendly, speak naturally like you understand student life in Akure. 
Key areas near FUTA: Oba-Ile, FUTA South Gate area, FUTA North Gate area, Ijapo Estate, Alagbaka, Shagari Village, Ifon Road, Oda Road.
If asked about a specific apartment's landlord contact, share the WhatsApp number from the listings above.`,
      messages: [...(history || []), { role: 'user', content: message }]
    });

    res.json({ reply: msg.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ VacanSee API running on http://localhost:${PORT}`);
  console.log(`   App: FUTA Student Housing Platform`);
});
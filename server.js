require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand
} = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json());

const s3 = new S3Client({ region: process.env.AWS_REGION });
const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const uploadMiddleware = multer({
  storage: multerS3({
    s3,
    bucket: process.env.S3_BUCKET,
    key: (req, file, cb) =>
      cb(null, `vacansee/${uuidv4()}-${file.originalname}`)
  })
}).array('photos', 10);

const safeNum = (val, fallback = 0) => {
  const n = Number(val);
  return isNaN(n) ? fallback : n;
};

/* ROUTE 1: Health check */
app.get('/', (req, res) => {
  res.json({ status: 'VacanSee API is running!', app: 'VacanSee - FUTA Student Housing' });
});

/* ROUTE 2: Upload apartment */
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
      title, location, zone, description,
      bedrooms, bathrooms, amenities,
      yearlyRent, monthlyRent, cautionFee, agencyFee, agreementFee,
      landlordName, whatsapp, phone, email,
      landlordSecret
    } = req.body;

    // Accept either yearlyRent (new) or monthlyRent (Lovable legacy field name)
    const rentValue = yearlyRent || monthlyRent;

    console.log('Incoming apartment body:', JSON.stringify(req.body));

    if (!title)    return res.status(400).json({ error: 'title is required.' });
    if (!location) return res.status(400).json({ error: 'location is required.' });
    if (!rentValue || isNaN(Number(rentValue)))
      return res.status(400).json({ error: 'Rent is required and must be a valid number.' });
    if (!bedrooms || isNaN(Number(bedrooms)))
      return res.status(400).json({ error: 'bedrooms is required and must be a valid number.' });
    if (!bathrooms || isNaN(Number(bathrooms)))
      return res.status(400).json({ error: 'bathrooms is required and must be a valid number.' });

    const imageUrls = (req.files || []).map(f => f.location);

    const parsedYearlyRent   = safeNum(rentValue);
    const parsedCautionFee   = safeNum(cautionFee);
    const parsedAgencyFee    = safeNum(agencyFee);
    const parsedAgreementFee = safeNum(agreementFee);
    const totalPackage = parsedYearlyRent + parsedCautionFee + parsedAgencyFee + parsedAgreementFee;

    let amenitiesList = [];
    if (Array.isArray(amenities)) amenitiesList = amenities;
    else if (typeof amenities === 'string' && amenities.trim())
      amenitiesList = amenities.split(',').map(a => a.trim());

    const apartment = {
      apartmentId:  uuidv4(),
      title, location,
      zone:         zone        || 'Akure',
      description:  description || '',
      bedrooms:     safeNum(bedrooms),
      bathrooms:    safeNum(bathrooms),
      amenities:    amenitiesList,
      yearlyRent:   parsedYearlyRent,
      cautionFee:   parsedCautionFee,
      agencyFee:    parsedAgencyFee,
      agreementFee: parsedAgreementFee,
      totalPackage,
      landlordName: landlordName  || 'Landlord',
      whatsapp:     whatsapp      || '',
      phone:        phone         || '',
      email:        email         || '',
      landlordSecret: landlordSecret || '',
      imageUrls,
      available: true,
      createdAt: new Date().toISOString()
    };

    await dynamo.send(new PutCommand({ TableName: 'Apartments', Item: apartment }));
    res.json({ success: true, apartment });
  } catch (err) {
    console.error('Save error:', err);
    res.status(500).json({ error: err.message });
  }
}

/* ROUTE 3: Get all apartments */
app.get('/api/apartments', async (req, res) => {
  try {
    const result = await dynamo.send(new ScanCommand({ TableName: 'Apartments' }));
    const sorted = (result.Items || [])
      .map(item => { const { landlordSecret, ...rest } = item; return rest; }) // never expose secret
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ apartments: sorted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ROUTE 4: Get apartment by ID */
app.get('/api/apartments/:id', async (req, res) => {
  try {
    const result = await dynamo.send(
      new GetCommand({ TableName: 'Apartments', Key: { apartmentId: req.params.id } })
    );
    if (result.Item) {
      const { landlordSecret, ...rest } = result.Item;
      res.json({ apartment: rest });
    } else {
      res.status(404).json({ error: 'Apartment not found' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ROUTE 5: Toggle availability (landlord secret required) */
app.patch('/api/apartments/:id/availability', async (req, res) => {
  try {
    const { available, landlordSecret } = req.body;

    const result = await dynamo.send(
      new GetCommand({ TableName: 'Apartments', Key: { apartmentId: req.params.id } })
    );
    if (!result.Item) return res.status(404).json({ error: 'Apartment not found.' });
    if (result.Item.landlordSecret && result.Item.landlordSecret !== landlordSecret)
      return res.status(403).json({ error: 'Invalid secret code. Access denied.' });

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

/* ROUTE 6: Delete listing (landlord secret required) */
app.delete('/api/apartments/:id', async (req, res) => {
  try {
    const { landlordSecret } = req.body;

    const result = await dynamo.send(
      new GetCommand({ TableName: 'Apartments', Key: { apartmentId: req.params.id } })
    );
    if (!result.Item) return res.status(404).json({ error: 'Apartment not found.' });
    if (result.Item.landlordSecret && result.Item.landlordSecret !== landlordSecret)
      return res.status(403).json({ error: 'Invalid secret code. Access denied.' });

    await dynamo.send(
      new DeleteCommand({ TableName: 'Apartments', Key: { apartmentId: req.params.id } })
    );

    res.json({ success: true, message: 'Listing deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ROUTE 7: AI Recommend */
app.post('/api/ai/recommend', async (req, res) => {
  try {
    const { budget, zone, bedrooms, preferences } = req.body;
    const listings = await dynamo.send(new ScanCommand({ TableName: 'Apartments' }));
    const listingText = listings.Items
      .filter(a => a.available)
      .map(a =>
        `ID: ${a.apartmentId} | ${a.title} | ${a.location} (${a.zone}) | Yearly: ₦${a.yearlyRent?.toLocaleString()} | Total Package: ₦${a.totalPackage?.toLocaleString()} | ${a.bedrooms} bed | Amenities: ${a.amenities?.join(', ')}`
      ).join('\n');

    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-5-20251001',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `You are VacanSee AI, a student housing assistant for FUTA students.

Student preferences:
- Budget: ₦${budget}/year
- Zone: ${zone || 'anywhere near FUTA'}
- Bedrooms: ${bedrooms}
- Preferences: ${preferences || 'none'}

Available Listings:
${listingText}

Recommend top 3 listings that best match the student's needs. Be concise and friendly.`
      }]
    });

    res.json({ recommendation: msg.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ROUTE 8: AI Chat */
app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    const listings = await dynamo.send(new ScanCommand({ TableName: 'Apartments' }));
    const listingText = listings.Items
      .filter(a => a.available)
      .map(a =>
        `${a.title} at ${a.location} — ₦${a.yearlyRent?.toLocaleString()}/year, total package ₦${a.totalPackage?.toLocaleString()}, ${a.bedrooms} bed, WhatsApp: ${a.whatsapp}`
      ).join('\n');

    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-5-20251001',
      max_tokens: 500,
      system: `You are VacanSee AI, a friendly student housing assistant for FUTA (Federal University of Technology Akure) students. Help students find affordable housing near campus. All prices are per year. For support, direct students to vacansee@gmail.com.

Current Available Listings:
${listingText}`,
      messages: [
        ...(history || []),
        { role: 'user', content: message }
      ]
    });

    res.json({ reply: msg.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ VacanSee API running on http://localhost:${PORT}`);
});
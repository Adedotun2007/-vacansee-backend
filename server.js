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

// ✅ SAFE NUMBER CONVERTER (ADDED)
const toNumber = (value) => {
  if (value === undefined || value === null || value === "") return 0;
  const cleaned = String(value).replace(/,/g, '');
  const num = Number(cleaned);
  return isNaN(num) ? 0 : num;
};

// AWS + Claude setup
const s3 = new S3Client({ region: process.env.AWS_REGION });
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// S3 image upload config
const upload = multer({
  storage: multerS3({
    s3,
    bucket: process.env.S3_BUCKET,
    key: (req, file, cb) => cb(null, `vacansee/${uuidv4()}-${file.originalname}`)
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
      monthlyRent, cautionFee, agencyFee, agreementFee,
      landlordName, whatsapp, phone, email
    } = req.body;

    // ✅ SAFE IMAGE HANDLING (FIXED)
    const imageUrls = req.files?.map(f => f.location) || [];

    // ✅ SAFE NUMBER CALCULATION (FIXED)
    const totalPackage =
      toNumber(monthlyRent) +
      toNumber(cautionFee) +
      toNumber(agencyFee) +
      toNumber(agreementFee);

    const apartment = {
      apartmentId: uuidv4(),
      title,
      location,
      zone: zone || 'Akure',
      description,

      // ✅ ALL NUMBERS FIXED
      bedrooms: toNumber(bedrooms),
      bathrooms: toNumber(bathrooms),

      amenities: amenities ? amenities.split(',') : [],

      monthlyRent: toNumber(monthlyRent),
      cautionFee: toNumber(cautionFee),
      agencyFee: toNumber(agencyFee),
      agreementFee: toNumber(agreementFee),

      totalPackage,

      landlordName: landlordName || 'Landlord',
      whatsapp: whatsapp || '',
      phone: phone || '',
      email: email || '',

      imageUrls,
      available: true,
      createdAt: new Date().toISOString()
    };

    await dynamo.send(new PutCommand({
      TableName: 'Apartments',
      Item: apartment
    }));

    res.json({ success: true, apartment });

  } catch (err) {
    console.error("UPLOAD ERROR:", err); // ✅ clearer log
    res.status(500).json({ error: err.message });
  }
});
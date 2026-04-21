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
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());

const s3 = new S3Client({ region: process.env.AWS_REGION });
const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Gmail transporter for OTP emails
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

/* =========================
   S3 upload middleware
========================= */
const uploadMiddleware = multer({
  storage: multerS3({
    s3,
    bucket: process.env.S3_BUCKET,
    key: (req, file, cb) =>
      cb(null, `vacansee/${uuidv4()}-${file.originalname}`)
  })
}).array('photos', 10);

const uploadSingle = multer({
  storage: multerS3({
    s3,
    bucket: process.env.S3_BUCKET,
    key: (req, file, cb) =>
      cb(null, `vacansee/profiles/${uuidv4()}-${file.originalname}`)
  })
}).single('profilePhoto');

/* =========================
   Helpers
========================= */
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

/* =========================
   ROUTE 1: Health check
========================= */
app.get('/', (req, res) => {
  res.json({ status: 'VacanSee V3 API running!', version: '3.0', app: 'VacanSee - FUTA Community Housing' });
});

/* =========================
   ADMIN ROUTES
========================= */

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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/list-pins', async (req, res) => {
  const { email, password } = req.body;
  if (email !== process.env.ADMIN_EMAIL || password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await dynamo.send(new ScanCommand({ TableName: 'AdminPins' }));
    const pins = (result.Items || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ pins });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/validate-pin', async (req, res) => {
  const { pin } = req.body;
  try {
    const result = await dynamo.send(new GetCommand({ TableName: 'AdminPins', Key: { pin } }));
    if (!result.Item) return res.json({ valid: false, reason: 'PIN does not exist' });
    if (result.Item.used) return res.json({ valid: false, reason: 'PIN already used' });
    if (new Date(result.Item.expiresAt) < new Date()) return res.json({ valid: false, reason: 'PIN expired' });
    res.json({ valid: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   OTP ROUTES
========================= */

// Send OTP — for signup verification AND password reset
app.post('/api/auth/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 mins
    await dynamo.send(new PutCommand({
      TableName: 'OTPCodes',
      Item: { email, otp, expiresAt, used: false, createdAt: new Date().toISOString() }
    }));
    await transporter.sendMail({
      from: `"VacanSee" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: 'VacanSee — Your Verification Code',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#f5f5f5;border-radius:16px">
          <h2 style="color:#1a5c35;margin-bottom:8px">VacanSee Verification</h2>
          <p style="color:#555;margin-bottom:20px">Your verification code — expires in 10 minutes:</p>
          <div style="background:#fff;border-radius:12px;padding:24px;text-align:center;border:2px solid #2d9e5f;margin-bottom:20px">
            <p style="font-size:40px;font-weight:900;letter-spacing:12px;color:#1a5c35;margin:0">${otp}</p>
          </div>
          <p style="color:#888;font-size:12px">If you didn't request this, ignore this email.</p>
          <p style="color:#888;font-size:12px">— VacanSee · vacansee@gmail.com</p>
        </div>
      `
    });
    res.json({ success: true, message: 'OTP sent!' });
  } catch (err) {
    console.error('OTP send error:', err);
    res.status(500).json({ error: 'Failed to send OTP. Check Gmail credentials in Railway Variables.' });
  }
});

// Verify OTP and reset password
app.post('/api/auth/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword)
    return res.status(400).json({ error: 'Email, OTP and new password are required' });
  if (newPassword.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const record = await dynamo.send(new GetCommand({ TableName: 'OTPCodes', Key: { email } }));
    if (!record.Item) return res.status(400).json({ error: 'No OTP found. Request a new one.' });
    if (record.Item.used) return res.status(400).json({ error: 'OTP already used. Request a new one.' });
    if (new Date(record.Item.expiresAt) < new Date()) return res.status(400).json({ error: 'OTP expired. Request a new one.' });
    if (record.Item.otp !== otp) return res.status(400).json({ error: 'Incorrect OTP. Check your email.' });

    // Mark OTP as used
    await dynamo.send(new UpdateCommand({
      TableName: 'OTPCodes', Key: { email },
      UpdateExpression: 'set #u = :u',
      ExpressionAttributeNames: { '#u': 'used' },
      ExpressionAttributeValues: { ':u': true }
    }));

    // Update agent password if found
    const landlord = await dynamo.send(new ScanCommand({
      TableName: 'LandlordProfiles',
      FilterExpression: 'email = :e',
      ExpressionAttributeValues: { ':e': email }
    }));
    if (landlord.Items?.length) {
      await dynamo.send(new UpdateCommand({
        TableName: 'LandlordProfiles', Key: { landlordId: landlord.Items[0].landlordId },
        UpdateExpression: 'set passwordHash = :p',
        ExpressionAttributeValues: { ':p': hashPassword(newPassword) }
      }));
    }

    // Update resident password if found
    const tenant = await dynamo.send(new ScanCommand({
      TableName: 'Tenants',
      FilterExpression: 'email = :e',
      ExpressionAttributeValues: { ':e': email }
    }));
    if (tenant.Items?.length) {
      await dynamo.send(new UpdateCommand({
        TableName: 'Tenants', Key: { tenantId: tenant.Items[0].tenantId },
        UpdateExpression: 'set passwordHash = :p',
        ExpressionAttributeValues: { ':p': hashPassword(newPassword) }
      }));
    }

    res.json({ success: true, message: 'Password reset successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   USERNAME CHECK
========================= */

app.get('/api/check-username', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Username required' });
  try {
    const result = await dynamo.send(new ScanCommand({
      TableName: 'LandlordProfiles',
      FilterExpression: 'username = :u',
      ExpressionAttributeValues: { ':u': username.toLowerCase().trim() }
    }));
    res.json({ available: !result.Items || result.Items.length === 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   LANDLORD AUTH ROUTES
========================= */

// Landlord signup (requires valid PIN + unique username)
app.post('/api/landlord/signup', (req, res) => {
  uploadSingle(req, res, async (err) => {
    if (err) return res.status(500).json({ error: 'Photo upload failed: ' + err.message });
    const { name, email, password, phone, whatsapp, bio, pin, username } = req.body;
    try {
      // Validate PIN
      const pinRecord = await dynamo.send(new GetCommand({ TableName: 'AdminPins', Key: { pin } }));
      if (!pinRecord.Item || pinRecord.Item.used || new Date(pinRecord.Item.expiresAt) < new Date())
        return res.status(400).json({ error: 'Invalid or expired PIN. Contact vacansee@gmail.com for a new one.' });

      // Check email not already used
      const existing = await dynamo.send(new ScanCommand({
        TableName: 'LandlordProfiles',
        FilterExpression: 'email = :e',
        ExpressionAttributeValues: { ':e': email }
      }));
      if (existing.Items && existing.Items.length > 0)
        return res.status(400).json({ error: 'An account with this email already exists' });

      // Check username not already taken
      if (username) {
        const usernameCheck = await dynamo.send(new ScanCommand({
          TableName: 'LandlordProfiles',
          FilterExpression: 'username = :u',
          ExpressionAttributeValues: { ':u': username.toLowerCase().trim() }
        }));
        if (usernameCheck.Items && usernameCheck.Items.length > 0)
          return res.status(400).json({ error: 'This username is already taken. Please choose another.' });
      }

      const landlordId = uuidv4();
      const profilePhotoUrl = req.file ? req.file.location : '';

      await dynamo.send(new PutCommand({
        TableName: 'LandlordProfiles',
        Item: {
          landlordId, name, email,
          username: username ? username.toLowerCase().trim() : '',
          passwordHash: hashPassword(password),
          phone: phone || '', whatsapp: whatsapp || '',
          bio: bio || '', profilePhotoUrl,
          verified: true,
          createdAt: new Date().toISOString(),
          averageRating: 0, totalReviews: 0
        }
      }));

      // Mark PIN as used
      await dynamo.send(new UpdateCommand({
        TableName: 'AdminPins',
        Key: { pin },
        UpdateExpression: 'set #u = :u, usedBy = :e, usedAt = :t',
        ExpressionAttributeNames: { '#u': 'used' },
        ExpressionAttributeValues: { ':u': true, ':e': email, ':t': new Date().toISOString() }
      }));

      res.json({ success: true, landlordId, name, email, username: username ? username.toLowerCase().trim() : '' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
});

// Landlord login
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
    res.json({ success: true, landlordId: l.landlordId, name: l.name, email: l.email, username: l.username || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get landlord profile + their listings (public)
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
    const safeListings = (listings.Items || []).map(({ landlordSecret, ...rest }) => rest);
    res.json({ landlord: publicProfile, listings: safeListings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get apartments by landlordId — for "My Listings" page
app.get('/api/landlord/:id/apartments', async (req, res) => {
  try {
    const result = await dynamo.send(new ScanCommand({
      TableName: 'Apartments',
      FilterExpression: 'landlordId = :id',
      ExpressionAttributeValues: { ':id': req.params.id }
    }));
    const sorted = (result.Items || [])
      .map(({ landlordSecret, ...rest }) => rest)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ apartments: sorted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update landlord profile
app.patch('/api/landlord/:id/update', uploadSingle, async (req, res) => {
  const { name, phone, whatsapp, bio, username } = req.body;
  const { id: landlordId } = req.params;
  try {
    if (username) {
      const check = await dynamo.send(new ScanCommand({
        TableName: 'LandlordProfiles',
        FilterExpression: 'username = :u AND landlordId <> :id',
        ExpressionAttributeValues: { ':u': username.toLowerCase().trim(), ':id': landlordId }
      }));
      if (check.Items?.length > 0)
        return res.status(400).json({ error: 'Username already taken' });
    }
    const profilePhotoUrl = req.file ? req.file.location : undefined;
    const updateParts = ['#n=:n', 'phone=:p', 'whatsapp=:w', 'bio=:b'];
    const exprValues = {
      ':n': name || '', ':p': phone || '',
      ':w': whatsapp || '', ':b': bio || ''
    };
    if (username) { updateParts.push('username=:u'); exprValues[':u'] = username.toLowerCase().trim(); }
    if (profilePhotoUrl) { updateParts.push('profilePhotoUrl=:pp'); exprValues[':pp'] = profilePhotoUrl; }

    await dynamo.send(new UpdateCommand({
      TableName: 'LandlordProfiles', Key: { landlordId },
      UpdateExpression: 'set ' + updateParts.join(', '),
      ExpressionAttributeNames: { '#n': 'name' },
      ExpressionAttributeValues: exprValues
    }));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete landlord account + all their listings
app.delete('/api/landlord/:id/account', async (req, res) => {
  try {
    const { password } = req.body;
    const { id: landlordId } = req.params;
    const result = await dynamo.send(new GetCommand({
      TableName: 'LandlordProfiles', Key: { landlordId }
    }));
    if (!result.Item) return res.status(404).json({ error: 'Account not found' });
    if (result.Item.passwordHash !== hashPassword(password))
      return res.status(403).json({ error: 'Incorrect password' });

    // Delete all their listings
    const listings = await dynamo.send(new ScanCommand({
      TableName: 'Apartments',
      FilterExpression: 'landlordId = :id',
      ExpressionAttributeValues: { ':id': landlordId }
    }));
    for (const listing of listings.Items || []) {
      await dynamo.send(new DeleteCommand({
        TableName: 'Apartments', Key: { apartmentId: listing.apartmentId }
      }));
    }

    // Delete the profile
    await dynamo.send(new DeleteCommand({
      TableName: 'LandlordProfiles', Key: { landlordId }
    }));
    res.json({ success: true, message: 'Account and all listings deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   TENANT AUTH ROUTES
========================= */

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
      Item: {
        tenantId, name, email,
        passwordHash: hashPassword(password),
        department: department || '', level: level || '',
        createdAt: new Date().toISOString()
      }
    }));
    res.json({ success: true, tenantId, name, email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete resident account
app.delete('/api/tenant/:id/account', async (req, res) => {
  try {
    const { password } = req.body;
    const { id: tenantId } = req.params;
    const result = await dynamo.send(new GetCommand({
      TableName: 'Tenants', Key: { tenantId }
    }));
    if (!result.Item) return res.status(404).json({ error: 'Account not found' });
    if (result.Item.passwordHash !== hashPassword(password))
      return res.status(403).json({ error: 'Incorrect password' });
    await dynamo.send(new DeleteCommand({
      TableName: 'Tenants', Key: { tenantId }
    }));
    res.json({ success: true, message: 'Account deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   APARTMENT ROUTES
========================= */

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
      landlordId, landlordSecret
    } = req.body;

    const rentValue = yearlyRent || monthlyRent;

    console.log('Incoming apartment body:', JSON.stringify(req.body));

    if (!title)    return res.status(400).json({ error: 'title is required.' });
    if (!location) return res.status(400).json({ error: 'location is required.' });
    if (!rentValue || isNaN(Number(rentValue)) || Number(rentValue) <= 0)
      return res.status(400).json({ error: 'Annual rent must be greater than zero.' });
    if (!bedrooms || isNaN(Number(bedrooms)))
      return res.status(400).json({ error: 'bedrooms is required and must be a number.' });
    if (!bathrooms || isNaN(Number(bathrooms)))
      return res.status(400).json({ error: 'bathrooms is required and must be a number.' });

    // Fetch landlord username to use as landlordName
    let resolvedLandlordName = landlordName || 'Landlord';
    if (landlordId) {
      try {
        const landlordRecord = await dynamo.send(new GetCommand({
          TableName: 'LandlordProfiles', Key: { landlordId }
        }));
        if (landlordRecord.Item) {
          resolvedLandlordName = landlordRecord.Item.username || landlordRecord.Item.name || resolvedLandlordName;
        }
      } catch (e) { /* fallback */ }
    }

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
      apartmentId:    uuidv4(),
      title, location,
      zone:           zone        || 'Akure',
      description:    description || '',
      bedrooms:       safeNum(bedrooms),
      bathrooms:      safeNum(bathrooms),
      amenities:      amenitiesList,
      yearlyRent:     parsedYearlyRent,
      cautionFee:     parsedCautionFee,
      agencyFee:      parsedAgencyFee,
      agreementFee:   parsedAgreementFee,
      totalPackage,
      landlordName:   resolvedLandlordName,
      whatsapp:       whatsapp    || '',
      phone:          phone       || '',
      email:          email       || '',
      landlordId:     landlordId  || '',
      landlordSecret: landlordSecret || '',
      imageUrls,
      available:      true,
      averageRating:  0,
      totalReviews:   0,
      createdAt:      new Date().toISOString()
    };

    await dynamo.send(new PutCommand({ TableName: 'Apartments', Item: apartment }));
    res.json({ success: true, apartment });
  } catch (err) {
    console.error('Save error:', err);
    res.status(500).json({ error: err.message });
  }
}

// Get all apartments (public)
app.get('/api/apartments', async (req, res) => {
  try {
    const result = await dynamo.send(new ScanCommand({ TableName: 'Apartments' }));
    const sorted = (result.Items || [])
      .map(({ landlordSecret, ...rest }) => rest)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ apartments: sorted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single apartment by ID
app.get('/api/apartments/:id', async (req, res) => {
  try {
    const result = await dynamo.send(
      new GetCommand({ TableName: 'Apartments', Key: { apartmentId: req.params.id } })
    );
    if (!result.Item) return res.status(404).json({ error: 'Apartment not found' });
    const { landlordSecret, ...rest } = result.Item;
    res.json({ apartment: rest });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle availability — verified by landlordId
app.patch('/api/apartments/:id/availability', async (req, res) => {
  try {
    const { available, landlordId } = req.body;
    const result = await dynamo.send(
      new GetCommand({ TableName: 'Apartments', Key: { apartmentId: req.params.id } })
    );
    if (!result.Item) return res.status(404).json({ error: 'Apartment not found.' });
    if (result.Item.landlordId !== landlordId)
      return res.status(403).json({ error: 'You do not own this listing.' });
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

// Delete listing — verified by landlordId
app.delete('/api/apartments/:id', async (req, res) => {
  try {
    const { landlordId } = req.body;
    const result = await dynamo.send(
      new GetCommand({ TableName: 'Apartments', Key: { apartmentId: req.params.id } })
    );
    if (!result.Item) return res.status(404).json({ error: 'Apartment not found.' });
    if (result.Item.landlordId !== landlordId)
      return res.status(403).json({ error: 'You do not own this listing.' });
    await dynamo.send(
      new DeleteCommand({ TableName: 'Apartments', Key: { apartmentId: req.params.id } })
    );
    res.json({ success: true, message: 'Listing deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit listing — verified by landlordId
app.patch('/api/apartments/:id/edit', async (req, res) => {
  try {
    const { landlordId, ...fields } = req.body;
    const result = await dynamo.send(new GetCommand({
      TableName: 'Apartments', Key: { apartmentId: req.params.id }
    }));
    if (!result.Item) return res.status(404).json({ error: 'Apartment not found' });
    if (result.Item.landlordId !== landlordId)
      return res.status(403).json({ error: 'You do not own this listing' });

    const rentValue = fields.yearlyRent || fields.monthlyRent;
    const parsedRent = safeNum(rentValue) || result.Item.yearlyRent;
    const totalPackage = parsedRent + safeNum(fields.cautionFee) + safeNum(fields.agencyFee) + safeNum(fields.agreementFee);

    await dynamo.send(new UpdateCommand({
      TableName: 'Apartments',
      Key: { apartmentId: req.params.id },
      UpdateExpression: 'set title = :t, #loc = :l, description = :d, yearlyRent = :r, totalPackage = :tp, bedrooms = :b, bathrooms = :ba, amenities = :am',
      ExpressionAttributeNames: { '#loc': 'location' },
      ExpressionAttributeValues: {
        ':t':  fields.title       || result.Item.title,
        ':l':  fields.location    || result.Item.location,
        ':d':  fields.description || result.Item.description,
        ':r':  parsedRent,
        ':tp': totalPackage,
        ':b':  safeNum(fields.bedrooms)  || result.Item.bedrooms,
        ':ba': safeNum(fields.bathrooms) || result.Item.bathrooms,
        ':am': Array.isArray(fields.amenities) ? fields.amenities : result.Item.amenities
      }
    }));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   REVIEWS ROUTES
========================= */

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
      Item: { reviewId, apartmentId, tenantId, tenantName, rating: Number(rating), comment, createdAt: new Date().toISOString() }
    }));

    const allReviews = await dynamo.send(new ScanCommand({
      TableName: 'Reviews',
      FilterExpression: 'apartmentId = :a',
      ExpressionAttributeValues: { ':a': apartmentId }
    }));
    const avg = allReviews.Items.reduce((s, r) => s + r.rating, 0) / allReviews.Items.length;
    await dynamo.send(new UpdateCommand({
      TableName: 'Apartments', Key: { apartmentId },
      UpdateExpression: 'set averageRating = :r, totalReviews = :t',
      ExpressionAttributeValues: { ':r': Math.round(avg * 10) / 10, ':t': allReviews.Items.length }
    }));

    res.json({ success: true, reviewId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   AI ROUTES
========================= */

app.post('/api/ai/recommend', async (req, res) => {
  try {
    const { budget, zone, bedrooms, preferences } = req.body;
    const listings = await dynamo.send(new ScanCommand({ TableName: 'Apartments' }));
    const listingText = listings.Items.filter(a => a.available).map(a =>
      `ID: ${a.apartmentId} | ${a.title} | ${a.location} (${a.zone}) | Yearly: ₦${a.yearlyRent?.toLocaleString()} | Total: ₦${a.totalPackage?.toLocaleString()} | ${a.bedrooms} bed | Rating: ${a.averageRating}/5 | Amenities: ${a.amenities?.join(', ')}`
    ).join('\n');
    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: `You are VacanSee AI for FUTA community in Akure. Budget: ₦${budget}/year, Zone: ${zone || 'anywhere near FUTA'}, Bedrooms: ${bedrooms}, Preferences: ${preferences || 'none'}.\n\nListings:\n${listingText}\n\nRecommend the best 3 options. Mention yearly pricing, ratings, and proximity to FUTA. Be friendly. For help, direct users to vacansee@gmail.com.` }]
    });
    res.json({ recommendation: msg.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    const listings = await dynamo.send(new ScanCommand({ TableName: 'Apartments' }));
    const listingText = listings.Items.filter(a => a.available).map(a =>
      `${a.title} at ${a.location} — ₦${a.yearlyRent?.toLocaleString()}/year, total ₦${a.totalPackage?.toLocaleString()}, ${a.bedrooms} bed, WhatsApp: ${a.whatsapp}`
    ).join('\n');
    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-5-20251001',
      max_tokens: 500,
      system: `You are VacanSee AI, a friendly housing assistant for FUTA (Federal University of Technology Akure) community. All prices are per year. For support, direct users to vacansee@gmail.com.\n\nAvailable listings:\n${listingText}`,
      messages: [...(history || []), { role: 'user', content: message }]
    });
    res.json({ reply: msg.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ VacanSee V3 API running on http://localhost:${PORT}`);
});
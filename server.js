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
const SibApiV3Sdk = require('sib-api-v3-sdk'); // Brevo
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');

const app = express();
app.use(cors());
app.use(express.json());
app.use(session({ secret: 'vacansee_session_secret', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());

const s3 = new S3Client({ region: process.env.AWS_REGION });
const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// Brevo setup
const brevoClient = SibApiV3Sdk.ApiClient.instance;
brevoClient.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;
const brevoApi = new SibApiV3Sdk.TransactionalEmailsApi();

/* =========================
   S3 upload middleware
========================= */
// Allowed MIME types — images and videos only, no other formats
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/mov', 'video/quicktime', 'video/webm'];
const ALLOWED_MEDIA_TYPES = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES];

function mediaFileFilter(req, file, cb) {
  if (ALLOWED_MEDIA_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type not allowed: ${file.mimetype}. Only JPG, PNG, WEBP images and MP4, MOV, WEBM videos are accepted.`), false);
  }
}

function imageOnlyFilter(req, file, cb) {
  if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type not allowed: ${file.mimetype}. Only JPG, PNG, WEBP images are accepted for profile photos.`), false);
  }
}

// Listing media: images + videos, max 10 files, max 100MB each
const uploadMiddleware = multer({
  storage: multerS3({
    s3,
    bucket: process.env.S3_BUCKET,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: (req, file, cb) =>
      cb(null, `vacansee/${uuidv4()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`)
  }),
  fileFilter: mediaFileFilter,
  limits: { fileSize: 100 * 1024 * 1024 }
}).array('photos', 10);

// Profile photo: images only, single file, max 5MB
const uploadSingle = multer({
  storage: multerS3({
    s3,
    bucket: process.env.S3_BUCKET,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: (req, file, cb) =>
      cb(null, `vacansee/profiles/${uuidv4()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`)
  }),
  fileFilter: imageOnlyFilter,
  limits: { fileSize: 5 * 1024 * 1024 }
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
   Email HTML Builder
========================= */
function buildOtpEmail(otp, purpose = 'verify') {
  const isReset = purpose === 'reset';
  const headline = isReset ? 'Password Reset' : 'Verify Your Email';
  const subtext = isReset
    ? 'You requested a password reset for your VacanSee account.'
    : 'Welcome to VacanSee! Use the code below to verify your email and complete signup.';
  const footerNote = isReset
    ? 'If you did not request a password reset, you can safely ignore this email.'
    : 'If you did not sign up for VacanSee, you can safely ignore this email.';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>VacanSee — ${headline}</title>
</head>
<body style="margin:0;padding:0;background:#0a0f0a;font-family:'Segoe UI',Arial,sans-serif;">

  <!-- Outer wrapper -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0f0a;padding:40px 16px;">
    <tr>
      <td align="center">

        <!-- Card -->
        <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#0f1a12;border-radius:20px;border:1px solid #1e3a23;overflow:hidden;">

          <!-- Top accent bar -->
          <tr>
            <td style="background:linear-gradient(90deg,#00c87a,#00a060,#007a45);height:4px;"></td>
          </tr>

          <!-- Header -->
          <tr>
            <td style="padding:36px 40px 0;text-align:center;">
              <!-- Logo mark -->
              <div style="display:inline-block;background:linear-gradient(135deg,#00c87a22,#00c87a11);border:1px solid #00c87a44;border-radius:16px;padding:12px 20px;margin-bottom:20px;">
                <span style="font-size:22px;font-weight:900;letter-spacing:-0.5px;color:#00c87a;">Vacan<span style="color:#ffffff;">See</span></span>
                <span style="display:block;font-size:10px;color:#4a7a55;letter-spacing:3px;text-transform:uppercase;margin-top:2px;">FUTA Housing</span>
              </div>

              <!-- Headline -->
              <h1 style="margin:0 0 10px;font-size:24px;font-weight:800;color:#ffffff;letter-spacing:-0.3px;">${headline}</h1>
              <p style="margin:0;font-size:14px;color:#6a9a75;line-height:1.6;max-width:380px;margin:0 auto;">${subtext}</p>
            </td>
          </tr>

          <!-- OTP Box -->
          <tr>
            <td style="padding:32px 40px;">
              <div style="background:#071209;border:2px solid #00c87a33;border-radius:16px;padding:28px 20px;text-align:center;position:relative;">
                <!-- Subtle label -->
                <p style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#3a6a45;">Your Code</p>
                <!-- OTP digits -->
                <div style="display:inline-flex;gap:8px;justify-content:center;">
                  ${otp.split('').map(digit => `
                  <span style="
                    display:inline-block;
                    width:44px;height:56px;line-height:56px;
                    background:#0f1a12;
                    border:1px solid #00c87a55;
                    border-radius:10px;
                    font-size:28px;font-weight:900;
                    color:#00c87a;
                    text-align:center;
                    font-family:'Courier New',monospace;
                  ">${digit}</span>`).join('')}
                </div>
                <!-- Expiry note -->
                <p style="margin:16px 0 0;font-size:12px;color:#3a6a45;">
                  ⏱ Expires in <strong style="color:#00c87a;">10 minutes</strong>
                </p>
              </div>
            </td>
          </tr>

          <!-- Info section -->
          <tr>
            <td style="padding:0 40px 20px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#071209;border:1px solid #1e3a23;border-radius:12px;padding:16px 18px;">
                    <p style="margin:0;font-size:12px;color:#4a7a55;line-height:1.7;">
                      🔒 <strong style="color:#6aaa80;">Never share this code</strong> with anyone — VacanSee staff will never ask for it.<br/>
                      📧 Having trouble? Email us at <a href="mailto:vacansee@gmail.com" style="color:#00c87a;text-decoration:none;">vacansee@gmail.com</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding:0 40px;">
              <div style="height:1px;background:#1e3a23;"></div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px 32px;text-align:center;">
              <p style="margin:0 0 6px;font-size:11px;color:#2a4a33;">${footerNote}</p>
              <p style="margin:0;font-size:11px;color:#2a4a33;">
                © 2025 VacanSee · FUTA Community Housing · Akure, Nigeria
              </p>
            </td>
          </tr>

        </table>
        <!-- End card -->

      </td>
    </tr>
  </table>

</body>
</html>
  `.trim();
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
  const { email, purpose } = req.body; // purpose: 'verify' | 'reset'
  if (!email) return res.status(400).json({ error: 'Email is required' });
  try {
    // ✅ RATE LIMIT: block if OTP was sent less than 60 seconds ago
    const existing = await dynamo.send(new GetCommand({ TableName: 'OTPCodes', Key: { email } }));
    if (existing.Item && !existing.Item.used) {
      const secondsAgo = (Date.now() - new Date(existing.Item.createdAt).getTime()) / 1000;
      if (secondsAgo < 60) {
        const waitSeconds = Math.ceil(60 - secondsAgo);
        return res.status(429).json({ error: `Please wait ${waitSeconds} seconds before requesting another OTP.` });
      }
    }

    // ✅ FOR PASSWORD RESET: block if email doesn't exist in either table
    if (purpose === 'reset') {
      const [agentResult, residentResult] = await Promise.all([
        dynamo.send(new ScanCommand({
          TableName: 'LandlordProfiles',
          FilterExpression: 'email = :e',
          ExpressionAttributeValues: { ':e': email }
        })),
        dynamo.send(new ScanCommand({
          TableName: 'Tenants',
          FilterExpression: 'email = :e',
          ExpressionAttributeValues: { ':e': email }
        }))
      ]);
      const agentExists = agentResult.Items && agentResult.Items.length > 0;
      const residentExists = residentResult.Items && residentResult.Items.length > 0;
      if (!agentExists && !residentExists)
        return res.status(404).json({ error: 'No account found with this email address.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 mins

    await dynamo.send(new PutCommand({
      TableName: 'OTPCodes',
      Item: { email, otp, expiresAt, used: false, createdAt: new Date().toISOString() }
    }));

    const isReset = purpose === 'reset';

    await brevoApi.sendTransacEmail({
      sender: { name: 'VacanSee', email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email }],
      subject: isReset
        ? 'VacanSee — Reset Your Password'
        : 'VacanSee — Verify Your Email',
      htmlContent: buildOtpEmail(otp, purpose || 'verify')
    });

    res.json({ success: true, message: 'OTP sent!' });
  } catch (err) {
    console.error('OTP send error:', err);
    res.status(500).json({ error: 'Failed to send OTP: ' + err.message });
  }
});

// Verify OTP only (for signup flow — just checks OTP, doesn't reset password)
app.post('/api/auth/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and OTP are required' });
  try {
    const record = await dynamo.send(new GetCommand({ TableName: 'OTPCodes', Key: { email } }));
    if (!record.Item) return res.status(400).json({ error: 'No OTP found. Request a new one.' });
    if (record.Item.used) return res.status(400).json({ error: 'OTP already used. Request a new one.' });
    if (new Date(record.Item.expiresAt) < new Date()) return res.status(400).json({ error: 'OTP expired. Request a new one.' });
    // ✅ String cast to prevent type mismatch (frontend may send as number)
    if (record.Item.otp !== String(otp).trim()) return res.status(400).json({ error: 'Incorrect OTP. Check your email.' });

    // Mark OTP as used
    await dynamo.send(new UpdateCommand({
      TableName: 'OTPCodes', Key: { email },
      UpdateExpression: 'set #u = :u',
      ExpressionAttributeNames: { '#u': 'used' },
      ExpressionAttributeValues: { ':u': true }
    }));

    res.json({ success: true, message: 'Email verified!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify OTP and reset password (for forgot password flow)
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
    if (record.Item.otp !== String(otp).trim()) return res.status(400).json({ error: 'Incorrect OTP. Check your email.' });

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
      // ✅ ENFORCE OTP VERIFICATION — email must be verified before signup
      const otpRecord = await dynamo.send(new GetCommand({ TableName: 'OTPCodes', Key: { email } }));
      if (!otpRecord.Item || !otpRecord.Item.used)
        return res.status(403).json({ error: 'Email not verified. Please verify your OTP first.' });

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
  const { name, email, password, userType, department, level } = req.body;
  try {
    // ✅ ENFORCE OTP VERIFICATION — email must be verified before signup
    const otpRecord = await dynamo.send(new GetCommand({ TableName: 'OTPCodes', Key: { email } }));
    if (!otpRecord.Item || !otpRecord.Item.used)
      return res.status(403).json({ error: 'Email not verified. Please verify your OTP first.' });

    const existing = await dynamo.send(new ScanCommand({
      TableName: 'Tenants',
      FilterExpression: 'email = :e',
      ExpressionAttributeValues: { ':e': email }
    }));
    if (existing.Items && existing.Items.length > 0)
      return res.status(400).json({ error: 'Account already exists with this email' });

    // userType: 'student' | 'staff' | 'other'
    // department is only required/saved when userType is 'student'
    const resolvedUserType = userType || 'student';
    const isStudent = resolvedUserType === 'student';

    const tenantId = uuidv4();
    await dynamo.send(new PutCommand({
      TableName: 'Tenants',
      Item: {
        tenantId, name, email,
        passwordHash: hashPassword(password),
        userType: resolvedUserType,
        department: isStudent ? (department || '') : '',
        level: isStudent ? (level || '') : '',
        createdAt: new Date().toISOString()
      }
    }));
    res.json({ success: true, tenantId, name, email, userType: resolvedUserType });
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
      model: 'claude-haiku-4-5-20251001',
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
      model: 'claude-haiku-4-5-20251001',
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
   GOOGLE OAUTH
========================= */

const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
console.log('Google Client Secret length:', googleClientSecret ? googleClientSecret.length : 'MISSING');

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: googleClientSecret,
  callbackURL: process.env.GOOGLE_CALLBACK_URL,
  passReqToCallback: false
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value;
    const name = profile.displayName;

    // Check if resident already exists
    const existing = await dynamo.send(new ScanCommand({
      TableName: 'Tenants',
      FilterExpression: 'email = :e',
      ExpressionAttributeValues: { ':e': email }
    }));
    if (existing.Items?.length) {
      return done(null, existing.Items[0]);
    }

    // Create new resident from Google account
    const tenantId = uuidv4();
    const newTenant = {
      tenantId, name, email,
      passwordHash: '',
      googleId: profile.id,
      department: '', level: '',
      createdAt: new Date().toISOString()
    };
    await dynamo.send(new PutCommand({ TableName: 'Tenants', Item: newTenant }));
    done(null, newTenant);
  } catch (err) { done(err, null); }
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// Redirect to Google login
app.get('/api/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// Google callback — redirects to frontend with user data
app.get('/api/auth/google/callback',
  passport.authenticate('google', { failureRedirect: `${process.env.FRONTEND_URL}/login?error=google_failed` }),
  (req, res) => {
    const user = req.user;
    const params = new URLSearchParams({
      tenantId: user.tenantId,
      name: user.name,
      email: user.email,
      googleAuth: 'true'
    });
    res.redirect(`${process.env.FRONTEND_URL}/auth/success?${params}`);
  }
);

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ VacanSee V3 API running on http://localhost:${PORT}`);
});
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(cookieParser());

const getRedirectUri = () => {
  const baseUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${baseUrl}/auth/callback`;
};

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  getRedirectUri()
);

const SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'https://www.googleapis.com/auth/calendar'
];

// OAuth Routes
app.get('/api/auth/google/url', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.json({ url });
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code as string);
    // In a real app, you'd associate these tokens with the Firebase user UID.
    // For now, we'll pass them back to the client to store (less secure but fits this context)
    // or set them in a cookie.
    
    // Send success and close popup
    res.send(`
      <html>
        <body>
          <script>
            window.opener.postMessage({ type: 'OAUTH_SUCCESS', tokens: ${JSON.stringify(tokens)} }, '*');
            window.close();
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error exchanging code for tokens', error);
    res.status(500).send('Authentication failed');
  }
});

// Classroom Data API
app.post('/api/classroom/assignments', async (req, res) => {
  const { tokens } = req.body;
  if (!tokens) return res.status(400).json({ error: 'Tokens required' });

  try {
    const auth = new google.auth.OAuth2();
    auth.setCredentials(tokens);
    const classroom = google.classroom({ version: 'v1', auth });

    // Get courses
    const coursesRes = await classroom.courses.list({ courseStates: ['ACTIVE'] });
    const courses = coursesRes.data.courses || [];
    
    const allAssignments: any[] = [];
    
    for (const course of courses) {
      const courseworkRes = await classroom.courses.courseWork.list({
        courseId: course.id!,
        orderBy: 'dueDate desc'
      });
      
      const assignments = (courseworkRes.data.courseWork || []).map(item => ({
        id: item.id,
        title: item.title,
        description: item.description,
        dueDate: item.dueDate ? new Date(item.dueDate.year!, item.dueDate.month! - 1, item.dueDate.day!).toISOString() : null,
        courseName: course.name,
        link: item.alternateLink,
        source: 'classroom'
      }));
      
      allAssignments.push(...assignments);
    }

    res.json(allAssignments);
  } catch (error) {
    console.error('Error fetching classroom data', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// Telegram notification endpoint (Trigger)
app.post('/api/notifications/telegram', async (req, res) => {
  const { botToken, chatId, message } = req.body;
  if (!botToken || !chatId || !message) return res.status(400).json({ error: 'Missing params' });

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message })
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error sending telegram message', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// Vite middleware
if (process.env.NODE_ENV !== 'production') {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  const distPath = path.join(process.cwd(), 'dist');
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize OpenAI client
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize SQLite database
const dbPath = path.join(__dirname, '..', 'cosmos.db');
const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS memory (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(conversation_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );
`);

// Helper function to generate UUID
function generateId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Helper function to get conversation memory
function getConversationMemory(conversationId) {
  const stmt = db.prepare('SELECT summary FROM memory WHERE conversation_id = ?');
  const result = stmt.get(conversationId);
  return result ? result.summary : null;
}

// Helper function to update conversation memory
async function updateConversationMemory(conversationId, messages) {
  if (messages.length === 0) return;

  // Get last 10 messages for context
  const recentMessages = messages.slice(-10);
  
  try {
    const summaryResponse = await client.chat.completions.create({
      model: 'gpt-4-mini',
      messages: [
        {
          role: 'system',
          content: 'Você é um assistente que cria resumos concisos de conversas. Resuma os pontos principais da conversa em português brasileiro em 2-3 frases.',
        },
        {
          role: 'user',
          content: `Resuma esta conversa:\n${recentMessages.map(m => `${m.role}: ${m.content}`).join('\n')}`,
        },
      ],
      temperature: 0.3,
    });

    const summary = summaryResponse.choices[0].message.content;
    
    // Upsert memory
    const stmt = db.prepare(`
      INSERT INTO memory (id, conversation_id, summary)
      VALUES (?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET summary = excluded.summary
    `);
    stmt.run(generateId(), conversationId, summary);
  } catch (error) {
    console.error('Error updating memory:', error);
  }
}

// Routes

// POST /chat - Send message and get response
app.post('/chat', async (req, res) => {
  try {
    const { conversation_id, message } = req.body;

    if (!conversation_id || !message) {
      return res.status(400).json({ error: 'conversation_id and message are required' });
    }

    // Get conversation
    const convStmt = db.prepare('SELECT * FROM conversations WHERE id = ?');
    const conversation = convStmt.get(conversation_id);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Get conversation history
    const historyStmt = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC');
    const history = historyStmt.all(conversation_id);

    // Get conversation memory
    const memory = getConversationMemory(conversation_id);

    // Build messages for API
    const messages = [
      {
        role: 'system',
        content: `Você é um assistente amigável e prestativo. Responda sempre em português brasileiro. ${
          memory ? `Contexto de conversas anteriores: ${memory}` : ''
        }`,
      },
      ...history,
      { role: 'user', content: message },
    ];

    // Call OpenAI API
    const response = await client.chat.completions.create({
      model: 'gpt-4-mini',
      messages: messages,
      temperature: 0.7,
      max_tokens: 500,
    });

    const assistantMessage = response.choices[0].message.content;

    // Save user message
    const userMsgId = generateId();
    const userStmt = db.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)');
    userStmt.run(userMsgId, conversation_id, 'user', message);

    // Save assistant message
    const assistantMsgId = generateId();
    const assistantStmt = db.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)');
    assistantStmt.run(assistantMsgId, conversation_id, 'assistant', assistantMessage);

    // Update conversation timestamp
    const updateStmt = db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    updateStmt.run(conversation_id);

    // Update memory in background
    const updatedHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: assistantMessage }];
    updateConversationMemory(conversation_id, updatedHistory).catch(err => console.error('Memory update error:', err));

    res.json({
      id: assistantMsgId,
      conversation_id: conversation_id,
      role: 'assistant',
      content: assistantMessage,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error in /chat:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /conversations - List all conversations
app.get('/conversations', (req, res) => {
  try {
    const stmt = db.prepare('SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC');
    const conversations = stmt.all();
    res.json(conversations);
  } catch (error) {
    console.error('Error in GET /conversations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /conversations/:id - Get messages from a conversation
app.get('/conversations/:id', (req, res) => {
  try {
    const { id } = req.params;

    // Get conversation
    const convStmt = db.prepare('SELECT * FROM conversations WHERE id = ?');
    const conversation = convStmt.get(id);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Get messages
    const msgStmt = db.prepare('SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC');
    const messages = msgStmt.all(id);

    res.json({
      ...conversation,
      messages,
    });
  } catch (error) {
    console.error('Error in GET /conversations/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /conversations - Create new conversation
app.post('/conversations', (req, res) => {
  try {
    const { title } = req.body;
    const conversationTitle = title || 'Nova Conversa';
    const id = generateId();

    const stmt = db.prepare('INSERT INTO conversations (id, title) VALUES (?, ?)');
    stmt.run(id, conversationTitle);

    res.status(201).json({
      id,
      title: conversationTitle,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error in POST /conversations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /conversations/:id - Delete conversation
app.delete('/conversations/:id', (req, res) => {
  try {
    const { id } = req.params;

    // Check if conversation exists
    const convStmt = db.prepare('SELECT * FROM conversations WHERE id = ?');
    const conversation = convStmt.get(id);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Delete conversation (cascade will delete messages and memory)
    const deleteStmt = db.prepare('DELETE FROM conversations WHERE id = ?');
    deleteStmt.run(id);

    res.json({ success: true, message: 'Conversation deleted' });
  } catch (error) {
    console.error('Error in DELETE /conversations/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Cosmos API is running' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Cosmos API running on http://localhost:${PORT}`);
  console.log(`Database: ${dbPath}`);
});

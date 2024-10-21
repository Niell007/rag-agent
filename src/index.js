import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { methodOverride } from 'hono/method-override';
import { setCookie, getCookie } from 'hono/cookie'

import notes from './notes.html';
import ui from './ui.html';
import write from './write.html';

const app = new Hono();

// Enable CORS for cross-origin requests
app.use(cors());

// Chat history middleware
app.use('*', async (c, next) => {
  const sessionId = getCookie(c, 'session_id') || crypto.randomUUID();
  setCookie(c, 'session_id', sessionId, {
    maxAge: 7 * 24 * 60 * 60, // 7 days
    path: '/'
  });
  await next();
});

// Fetch all notes in JSON format
app.get('/notes.json', async (c) => {
  try {
    const query = `SELECT * FROM notes ORDER BY created_at DESC`;
    const { results } = await c.env.DB.prepare(query).all();
    return c.json(results);
  } catch (error) {
    return c.json({ error: 'Failed to fetch notes' }, 500);
  }
});

// Display notes as HTML
app.get('/notes', async (c) => {
  return c.html(notes);
});

// Chat history endpoint
app.get('/chat/history', async (c) => {
  const sessionId = getCookie(c, 'session_id');
  try {
    const query = `
      SELECT * FROM chat_history
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT 50
    `;
    const { results } = await c.env.DB.prepare(query).bind(sessionId).all();
    return c.json(results);
  } catch (error) {
    return c.json({ error: 'Failed to fetch chat history' }, 500);
  }
});

// Save chat message
app.post('/chat/message', async (c) => {
  const sessionId = getCookie(c, 'session_id');
  const { message, role } = await c.req.json();

  try {
    const query = `
      INSERT INTO chat_history (session_id, message, role, timestamp)
      VALUES (?, ?, ?, datetime('now'))
      RETURNING *
    `;
    const { results } = await c.env.DB.prepare(query)
      .bind(sessionId, message, role)
      .all();
    return c.json(results[0]);
  } catch (error) {
    return c.json({ error: 'Failed to save chat message' }, 500);
  }
});

// Override method to support DELETE requests
app.use('/notes/:id', methodOverride({ app }));

// Delete a note by ID and remove from the vector index
app.delete('/notes/:id', async (c) => {
  const { id } = c.req.param();
  try {
    const query = `DELETE FROM notes WHERE id = ?`;
    await c.env.DB.prepare(query).bind(id).run();
    await c.env.VECTOR_INDEX.deleteByIds([id]);
    return c.redirect('/notes');
  } catch (error) {
    return c.json({ error: 'Failed to delete note' }, 500);
  }
});

// Create a new note and generate vector embedding
app.post('/notes', async (c) => {
  const { text } = await c.req.json();
  if (!text) return c.json({ error: 'Missing text' }, 400);

  try {
    const { results } = await c.env.DB.prepare(
      "INSERT INTO notes (text, created_at) VALUES (?, datetime('now')) RETURNING *"
    )
      .bind(text)
      .all();

    const record = results.length ? results[0] : null;
    if (!record) return c.json({ error: 'Failed to create note' }, 500);

    // Generate vector embeddings using Workers AI
    const { data } = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] });
    const values = data[0];
    if (!values) return c.json({ error: 'Failed to generate vector embedding' }, 500);

    const { id } = record;
    const inserted = await c.env.VECTOR_INDEX.upsert([{ id: id.toString(), values }]);
    return c.json({ id, text, inserted });
  } catch (error) {
    return c.json({ error: 'Failed to create note or generate embedding' }, 500);
  }
});

// Display UI for interacting with the AI
app.get('/ui', async (c) => {
  return c.html(ui);
});

// Display the note creation UI
app.get('/write', async (c) => {
  return c.html(write);
});

// Main chat route for handling AI queries
app.post('/chat', async (c) => {
  const { message } = await c.req.json();
  const sessionId = getCookie(c, 'session_id');

  try {
    // Generate embeddings from the message
    const embeddings = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: message });
    const vectors = embeddings.data[0];

    // Query the vector index for relevant context
    const vectorQuery = await c.env.VECTOR_INDEX.query(vectors, { topK: 3 });
    const vecIds = vectorQuery.matches.map(match => match.vectorId);

    // Fetch relevant notes
    let contextNotes = [];
    if (vecIds.length) {
      const placeholders = vecIds.map(() => '?').join(',');
      const query = `SELECT * FROM notes WHERE id IN (${placeholders})`;
      const { results } = await c.env.DB.prepare(query).bind(...vecIds).all();
      contextNotes = results.map(note => note.text);
    }

    // Fetch recent chat history
    const historyQuery = `
      SELECT * FROM chat_history
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT 5
    `;
    const { results: historyResults } = await c.env.DB.prepare(historyQuery)
      .bind(sessionId)
      .all();

    const chatHistory = historyResults.reverse().map(msg => ({
      role: msg.role,
      content: msg.message
    }));

    // Prepare context and system messages
    const contextMessage = contextNotes.length
      ? `Relevant context:\n${contextNotes.map(note => `- ${note}`).join('\n')}`
      : '';

    const systemPrompt = `
      You are a helpful AI assistant. When answering:
      1. Use the provided context when relevant
      2. Keep responses clear and concise
      3. If unsure, acknowledge uncertainty
      4. Maintain a friendly, professional tone
    `;

    // Generate AI response
    const { response: aiResponse } = await c.env.AI.run(
      '@cf/meta/llama-3-8b-instruct',
      {
        messages: [
          { role: 'system', content: systemPrompt },
          ...(contextMessage ? [{ role: 'system', content: contextMessage }] : []),
          ...chatHistory,
          { role: 'user', content: message }
        ]
      }
    );

    // Save the interaction
    await c.env.DB.prepare(`
      INSERT INTO chat_history (session_id, message, role, timestamp)
      VALUES (?, ?, 'user', datetime('now'))
    `).bind(sessionId, message).run();

    await c.env.DB.prepare(`
      INSERT INTO chat_history (session_id, message, role, timestamp)
      VALUES (?, ?, 'assistant', datetime('now'))
    `).bind(sessionId, aiResponse).run();

    return c.json({
      response: aiResponse,
      context: contextNotes
    });

  } catch (error) {
    return c.json({ error: 'Failed to process chat message' }, 500);
  }
});

// Error handling
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

export default app;

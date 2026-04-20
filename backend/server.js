const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
const cheerio = require('cheerio');

dotenv.config();

const app = express();
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/', (req, res) => {
  res.send('ReviewMind API is running ✅');
});

// ─── Gemini Proxy ────────────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

app.post('/api/gemini-analyze', async (req, res) => {
  try {
    const { texts } = req.body;
    if (!texts || !Array.isArray(texts)) {
      return res.status(400).json({ error: "Please provide an array of 'texts'." });
    }

    const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');

    const geminiRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        generationConfig: { temperature: 0, maxOutputTokens: 8192 },
        contents: [{
          parts: [{
            text: `You are a review analysis engine. Analyze each review below and return ONLY a valid JSON array. No markdown, no explanation, JSON only.

For each review return an object with exactly these fields:
- "emotion": one of: joy, anger, disgust, fear, sadness, surprise, neutral
- "sentiment": one of: positive, negative, neutral
- "painPoint": one of: product quality, delivery issue, packaging problem, customer service, pricing, none

Reviews to analyze:
${numbered}

Return exactly ${texts.length} objects in the array, in the same order.`
          }]
        }]
      })
    });

    if (geminiRes.status === 429) {
      return res.status(429).json({ error: "Gemini rate limit hit. Please retry shortly." });
    }
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return res.status(geminiRes.status).json({ error: `Gemini error: ${errText}` });
    }

    const data = await geminiRes.json();
    let raw = data.candidates[0].content.parts[0].text.trim();

    if (raw.includes('```')) {
      raw = raw.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error("Gemini returned malformed JSON:", raw.slice(0, 200));
      parsed = texts.map(() => ({ emotion: 'neutral', sentiment: 'neutral', painPoint: 'none' }));
    }

    if (!Array.isArray(parsed)) {
      parsed = texts.map(() => ({ emotion: 'neutral', sentiment: 'neutral', painPoint: 'none' }));
    }

    const results = texts.map((_, idx) => parsed[idx] || { emotion: 'neutral', sentiment: 'neutral', painPoint: 'none' });

    res.json({ results });
  } catch (error) {
    console.error("Gemini proxy error:", error.message);
    res.status(500).json({ error: "Gemini proxy failed: " + error.message });
  }
});

// ─── Scraper ─────────────────────────────────────────────────────────────────

const BOILERPLATE_PATTERNS = [
  'found a lower price',
  'fields with an asterisk',
  'review attachment',
  'positive ratings from',
  'recent orders from',
  'years on amazon',
  'top brand',
  'share:',
  'sign in',
  'sponsored',
  'see more reviews',
  'helpful?',
  'report abuse',
  'cookie',
  'add to cart',
  'add to wishlist',
  'customer questions',
];

const isBoilerplate = (text) => {
  if (!text || text.trim().length < 5) return true;
  const lower = text.toLowerCase();
  return BOILERPLATE_PATTERNS.some(p => lower.includes(p));
};

app.post('/api/scrape', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "No URL provided." });

    console.log(`[Scraper] Attempting to scrape: ${url}`);

    // Using ScraperAPI with JavaScript rendering
    const response = await axios.get(`http://api.scraperapi.com?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&render=true`);

    const html = response.data;
    const lowHtml = html.toLowerCase();
    const $ = cheerio.load(html);

    // ─── Bot Detection ───────────────────────────────────────────────────────
    const botIndicators = ["captcha", "robot check", "automated access", "security reach", "access denied", "ddos-guard", "cloudflare"];
    if (botIndicators.some(ind => lowHtml.includes(ind)) && !lowHtml.includes("review")) {
       console.warn(`[Scraper] Bot protection detected at ${url}`);
       return res.status(403).json({ 
          error: "This website is blocking our automated scraper. Please download the reviews as a CSV and upload them manually for 100% accuracy." 
       });
    }

    // Metadata extraction (Product Info)
    const resolveUrl = (path, base) => {
      try {
        if (!path) return null;
        return new URL(path, base).href;
      } catch {
        return path;
      }
    };

    const productImageRaw = 
      $('#landingImage').attr('src') || 
      $('#main-image').attr('src') ||
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      $('img').first().attr('src') || null;

    const productImage = resolveUrl(productImageRaw, url);

    let productName = $('meta[property="og:title"]').attr('content') ||
      $('title').text().trim() || null;

    if (productName) {
      productName = productName.replace(/Amazon\.com.*: | Reviews.*\| Trustpilot|Customer Reviews: /gi, '').trim();
    }

    const reviews = [];
    const seenTexts = new Set();
    
    // ─── Site-Specific Extraction ──────────────────────────────────────────
    const isAmazon = url.includes('amazon');
    const isTrustpilot = url.includes('trustpilot');

    if (isAmazon) {
      $('[data-hook="review"]').each((_, el) => {
        const text = $(el).find('[data-hook="review-body"] span').text().trim();
        const rating = $(el).find('[data-hook="review-star-rating"] .a-icon-alt, [data-hook="cmps-review-star-rating"] .a-icon-alt').text().trim();
        const author = $(el).find('[data-hook="profile-name"]').text().trim();
        const date = $(el).find('[data-hook="review-date"]').text().trim();
        const title = $(el).find('[data-hook="review-title"] span').text().trim();
        
        let images = [];
        $(el).find('img').each((_, img) => {
          const src = resolveUrl($(img).attr('src'), url);
          if (src && !src.includes('avatar') && !src.includes('profile')) images.push(src);
        });

        if (text && !seenTexts.has(text.toLowerCase())) {
          seenTexts.add(text.toLowerCase());
          reviews.push({ text, rating, author, date, title, images });
        }
      });
    } else if (isTrustpilot) {
      $('article[class*="review"]').each((_, el) => {
        const text = $(el).find('[data-service-review-text-typography]').text().trim();
        const rating = $(el).find('div[data-service-review-rating] img').attr('alt');
        const author = $(el).find('span[data-consumer-name-typography]').text().trim();
        const date = $(el).find('time').attr('datetime');
        const title = null;
        
        let images = [];
        $(el).find('img').each((_, img) => {
          const src = resolveUrl($(img).attr('src'), url);
          if (src && !src.includes('avatar') && !src.includes('consumer')) images.push(src);
        });

        if (text && !seenTexts.has(text.toLowerCase())) {
          seenTexts.add(text.toLowerCase());
          reviews.push({ text, rating, author, date, title, images });
        }
      });
    } else {
      // ─── Generic Fallback ──────────────────────────────────────────────────
      const primarySelectors = [
         'article', 'span[data-hook="review-body"]', '[class*="review-content"]',
         '[class*="review-text"]', '[class*="comment-text"]', '[class*="review-body"]',
         '[data-testid*="review"]', '.typography_body-l__KUYFJ', '.styles_reviewContent__0Q2Tg',
         '.review-item', '.comment-content'
      ].join(', ');

      let nodes = $(primarySelectors);

      if (nodes.length === 0) {
         $('div, span, p').each((_, el) => {
            const text = $(el).text().trim();
            if (text.length > 50 && text.length < 2000) {
               const parent = $(el).parent();
               if (parent.children().length > 2) nodes = nodes.add(el);
            }
         });
      }

      nodes.each((_, el) => {
        const rawText = $(el).text().trim();
        if (rawText.length < 3 || isBoilerplate(rawText)) return;
        
        let images = [];
        const reviewCard = $(el).closest('article, li, [class*="review"], [class*="card"], [class*="comment"], [class*="item"]');
        const searchContext = reviewCard.length > 0 ? reviewCard : $(el).parent();

        searchContext.find('img').each((i, img) => {
          const src = resolveUrl($(img).attr('src'), url);
          if (src && !src.includes('avatar') && !src.includes('logo')) images.push(src);
        });

        if (!seenTexts.has(rawText.toLowerCase())) {
          seenTexts.add(rawText.toLowerCase());
          reviews.push({ text: rawText, rating: null, author: "Anonymous", date: null, title: null, images });
        }
      });
    }

    if (reviews.length === 0) {
       return res.status(404).json({ error: "Could not find any meaningful review content on this page." });
    }

    console.log(`[Scraper] Successfully extracted ${reviews.length} reviews from ${url}`);
    res.json({ productName, productImage, reviews });
  } catch (error) {
    console.error("Scraping error:", error.message);
    res.status(500).json({ error: "Failed to scrape URL. " + error.message });
  }
});

// ─── HuggingFace Analyze (legacy) ──────────────────────────

const { HfInference } = require('@huggingface/inference');
const hf = new HfInference(process.env.HUGGINGFACE_API_KEY);

const SENTIMENT_MODEL = "cardiffnlp/twitter-xlm-roberta-base-sentiment";
const ZERO_SHOT_MODEL = "MoritzLaurer/mDeBERTa-v3-base-mnli-xnli";

app.post('/api/analyze', async (req, res) => {
  try {
    const { texts } = req.body;
    if (!texts || !Array.isArray(texts)) {
      return res.status(400).json({ error: "Please provide an array of 'texts'." });
    }

    const limitedTexts = texts.slice(0, 500);
    const MAX_CONCURRENT = 25;
    let results = new Array(limitedTexts.length).fill(null);

    for (let i = 0; i < limitedTexts.length; i += MAX_CONCURRENT) {
      const batchParams = limitedTexts.slice(i, i + MAX_CONCURRENT).map(async (text, idx) => {
        const actualIndex = i + idx;
        try {
          const [sentimentData, emotionData, painPointsData] = await Promise.all([
            hf.textClassification({ model: SENTIMENT_MODEL, inputs: text }).catch(() => null),
            hf.zeroShotClassification({
              model: ZERO_SHOT_MODEL,
              inputs: text,
              parameters: { candidate_labels: ["joy", "anger", "disgust", "fear", "sadness", "surprise", "neutral"] }
            }).catch(() => null),
            hf.zeroShotClassification({
              model: ZERO_SHOT_MODEL,
              inputs: text,
              parameters: { candidate_labels: ["product quality", "delivery issue", "packaging problem", "customer service", "pricing concern", "sizing issue", "none"] }
            }).catch(() => null)
          ]);

          const sRaw = sentimentData ? (Array.isArray(sentimentData) ? sentimentData : [sentimentData]) : null;
          const eRaw = emotionData ? [[{ label: emotionData.labels[0], score: emotionData.scores[0] }]] : null;
          const pRaw = painPointsData ? { labels: painPointsData.labels, scores: painPointsData.scores } : null;

          results[actualIndex] = {
            emotionsRaw: eRaw,
            sentimentRaw: sRaw ? [sRaw] : null,
            painPointsRaw: pRaw
          };
        } catch (err) {
          console.error(`Item ${actualIndex} failed:`, err.message);
          results[actualIndex] = { emotionsRaw: null, sentimentRaw: null, painPointsRaw: null };
        }
      });

      await Promise.all(batchParams);
      if (i + MAX_CONCURRENT < limitedTexts.length) await new Promise(r => setTimeout(r, 600));
    }

    res.json({ results });
  } catch (error) {
    console.error("Analysis Pipeline Error:", error);
    res.status(500).json({ error: "Failed to process text." });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`ReviewMind Backend running on port ${PORT}`);
    console.log(`CORS allowed origin: ${ALLOWED_ORIGIN}`);
});
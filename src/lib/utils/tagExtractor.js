import { marketplaceListings } from "../marketplace/listings.js";
import { getTaxonomy } from "../backend/taxonomy.js";

const STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are", "as", "at",
  "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
  "can", "did", "do", "does", "doing", "don", "down", "during",
  "each", "few", "for", "from", "further", "had", "has", "have", "having", "he", "her", "here", "hers", "herself",
  "him", "himself", "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself", "just",
  "me", "more", "most", "my", "myself", "no", "nor", "not", "now", "of", "off", "on", "once", "only", "or", "other", "our", "ours", "ourselves", "out", "over", "own",
  "same", "she", "should", "so", "some", "such", "than", "that", "the", "their", "theirs", "them", "themselves", "then", "there", "these", "they", "this", "those", "through", "to", "too", "under", "until", "up", "very",
  "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why", "will", "with", "you", "your", "yours", "yourself", "yourselves",
  // Common document descriptive words that don't make good standalone search tags
  "notes", "complete", "lecture", "lectures", "summary", "guide", "slides", "workbook", "workbooks", "template", "templates", "useful", "practice", "exam", "student", "students", "paper", "papers"
]);

const MAX_TITLE_LEN = 1000;
const MAX_DESC_LEN = 20000;

function cleanText(text, maxLen = MAX_DESC_LEN) {
  if (!text) return "";
  const sliced = String(text).slice(0, maxLen);
  return sliced
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

let cachedTagPool = null;

export function getTagPool() {
  if (cachedTagPool) return cachedTagPool;

  const tags = new Set();
  const seenLower = new Set();

  const addTag = (tag) => {
    if (!tag) return;
    const clean = tag.trim();
    if (!clean) return;
    const lower = clean.toLowerCase();
    if (STOP_WORDS.has(lower)) return;
    if (!seenLower.has(lower)) {
      seenLower.add(lower);
      tags.add(clean);
    }
  };

  if (Array.isArray(marketplaceListings)) {
    for (const listing of marketplaceListings) {
      if (Array.isArray(listing.tags)) {
        for (const t of listing.tags) {
          addTag(t);
        }
      }
    }
  }

  try {
    const taxonomy = getTaxonomy();
    if (taxonomy && Array.isArray(taxonomy.subjects)) {
      for (const sub of taxonomy.subjects) {
        addTag(sub.label);
        if (Array.isArray(sub.aliases)) {
          for (const alias of sub.aliases) {
            addTag(alias);
          }
        }
      }
    }
  } catch (e) {
    console.warn("Could not load taxonomy subjects for tag pool:", e.message);
  }

  cachedTagPool = Array.from(tags);
  return cachedTagPool;
}

export function suggestTags(title, description) {
  const startTime = performance.now();

  const cleanTitle = cleanText(title, MAX_TITLE_LEN);
  const cleanDescription = cleanText(description, MAX_DESC_LEN);

  const paddedTitle = ` ${cleanTitle} `;
  const paddedDesc = ` ${cleanDescription} `;

  const titleWords = cleanTitle.split(" ").filter(w => w.length > 1 && !STOP_WORDS.has(w));
  const descWords = cleanDescription.split(" ").filter(w => w.length > 1 && !STOP_WORDS.has(w));

  const keywordCounts = {};
  for (const w of titleWords) {
    keywordCounts[w] = (keywordCounts[w] || 0) + 3;
  }
  for (const w of descWords) {
    keywordCounts[w] = (keywordCounts[w] || 0) + 1;
  }

  const pool = getTagPool();
  const scoredTags = [];

  for (const tag of pool) {
    const tagLower = tag.toLowerCase();
    let score = 0;

    if (paddedTitle.includes(` ${tagLower} `)) {
      score += 15;
    } else if (paddedDesc.includes(` ${tagLower} `)) {
      score += 8;
    }

    const tagWords = tagLower.split(" ").filter(w => w.length > 1);
    let wordMatches = 0;
    for (const tw of tagWords) {
      if (keywordCounts[tw]) {
        score += keywordCounts[tw] * 2;
        wordMatches++;
      }
    }

    if (tagWords.length === 1) {
      const singleTag = tagWords[0];
      if (singleTag.length >= 3) {
        for (const kw of Object.keys(keywordCounts)) {
          if (kw !== singleTag && (kw.includes(singleTag) || singleTag.includes(kw))) {
            score += keywordCounts[kw] * 0.5;
          }
        }
      }
    }

    if (score > 0) {
      scoredTags.push({ tag, score });
    }
  }

  scoredTags.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.tag.length !== a.tag.length) return b.tag.length - a.tag.length;
    return a.tag.localeCompare(b.tag);
  });

  const recommendations = scoredTags.map(item => item.tag);

  if (recommendations.length < 5) {
    const recsLower = new Set(recommendations.map(r => r.toLowerCase()));
    const sortedKeywords = Object.entries(keywordCounts)
      .map(([word, weight]) => ({ word, weight }))
      .sort((a, b) => b.weight - a.weight);

    for (const item of sortedKeywords) {
      if (recommendations.length >= 5) break;
      const kwLower = item.word.toLowerCase();
      if (STOP_WORDS.has(kwLower)) continue;

      let formattedWord = item.word;
      if (/^[a-z]{2,4}-?\d{3,4}$/i.test(formattedWord)) {
        formattedWord = formattedWord.toUpperCase();
      } else {
        formattedWord = formattedWord.charAt(0).toUpperCase() + formattedWord.slice(1);
      }

      if (!recsLower.has(kwLower)) {
        recsLower.add(kwLower);
        recommendations.push(formattedWord);
      }
    }
  }

  const top5 = recommendations.slice(0, 5);
  const durationMs = performance.now() - startTime;

  return {
    tags: top5,
    durationMs
  };
}


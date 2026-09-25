const CATEGORIES = [
  { id: "academic", label: "Academic", description: "University and school academic materials" },
  { id: "professional", label: "Professional", description: "Professional development and certification" },
  { id: "skills", label: "Skills & Crafts", description: "Practical skills, crafts, and hobbies" },
  { id: "test-prep", label: "Test Preparation", description: "Standardized test preparation materials" },
  { id: "research", label: "Research", description: "Research papers, theses, and publications" },
];

const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
const CATEGORY_LABELS = new Set(CATEGORIES.map((c) => c.label.toLowerCase()));

const SUBJECTS = [
  { id: "mathematics", label: "Math", aliases: ["maths", "mathematics", "algebra", "calculus", "geometry", "trigonometry", "statistics"], categoryId: "academic" },
  { id: "science", label: "Science", aliases: ["general science", "integrated science", "basic science"], categoryId: "academic" },
  { id: "physics", label: "Physics", aliases: ["physics"], categoryId: "academic" },
  { id: "chemistry", label: "Chemistry", aliases: ["chemistry"], categoryId: "academic" },
  { id: "biology", label: "Biology", aliases: ["biology"], categoryId: "academic" },
  { id: "law", label: "Law", aliases: ["law", "legal", "jurisprudence"], categoryId: "academic" },
  { id: "technology", label: "Technology", aliases: ["tech", "it", "information technology", "computer science", "computing", "programming"], categoryId: "academic" },
  { id: "business", label: "Business", aliases: ["business", "commerce", "entrepreneurship", "management", "accounting", "finance", "economics"], categoryId: "academic" },
  { id: "medicine", label: "Medicine", aliases: ["medicine", "medical", "nursing", "health", "healthcare", "clinical"], categoryId: "academic" },
  { id: "pharmacy", label: "Pharmacy", aliases: ["pharmacy", "pharmaceutical"], categoryId: "academic" },
  { id: "engineering", label: "Engineering", aliases: ["engineering", "engineer"], categoryId: "academic" },
  { id: "arts", label: "Arts", aliases: ["arts", "art", "fine arts", "visual arts", "performing arts", "music", "theatre", "drama"], categoryId: "academic" },
  { id: "social-sciences", label: "Social Sciences", aliases: ["social sciences", "social science", "sociology", "psychology", "political science", "anthropology", "geography", "history"], categoryId: "academic" },
  { id: "humanities", label: "Humanities", aliases: ["humanities", "philosophy", "literature", "religious studies", "theology"], categoryId: "academic" },
  { id: "education", label: "Education", aliases: ["education", "teaching", "pedagogy", "curriculum"], categoryId: "academic" },
  { id: "languages", label: "Languages", aliases: ["language", "english", "french", "spanish", "foreign language", "linguistics"], categoryId: "academic" },
  { id: "certification", label: "Certification", aliases: ["certification", "certificate", "professional certification"], categoryId: "professional" },
  { id: "test-prep", label: "Test Preparation", aliases: ["test prep", "exam prep", "sat", "act", "gre", "gmat", "toefl", "ielts"], categoryId: "test-prep" },
];

const SUBJECT_BY_ID = new Map(SUBJECTS.map((s) => [s.id, s]));
const SUBJECT_BY_LABEL_LOWER = new Map(SUBJECTS.map((s) => [s.label.toLowerCase(), s]));

const ALIAS_MAP = new Map();
for (const subject of SUBJECTS) {
  for (const alias of subject.aliases) {
    ALIAS_MAP.set(alias.toLowerCase(), subject);
  }
}

const LEVELS = [
  { id: "beginner", label: "Beginner" },
  { id: "intermediate", label: "Intermediate" },
  { id: "advanced", label: "Advanced" },
  { id: "all-levels", label: "All Levels" },
];

const LEVEL_IDS = new Set(LEVELS.map((l) => l.id));

export function normalizeSubject(input) {
  if (!input) return null;
  const cleaned = String(input).trim().toLowerCase();
  if (!cleaned) return null;

  const byId = SUBJECT_BY_ID.get(cleaned);
  if (byId) return { id: byId.id, label: byId.label, categoryId: byId.categoryId };

  const byLabel = SUBJECT_BY_LABEL_LOWER.get(cleaned);
  if (byLabel) return { id: byLabel.id, label: byLabel.label, categoryId: byLabel.categoryId };

  const byAlias = ALIAS_MAP.get(cleaned);
  if (byAlias) return { id: byAlias.id, label: byAlias.label, categoryId: byAlias.categoryId };

  return null;
}

export function normalizeCategory(input) {
  if (!input) return null;
  const cleaned = String(input).trim().toLowerCase();
  if (!cleaned) return null;

  if (CATEGORY_IDS.has(cleaned)) {
    const cat = CATEGORIES.find((c) => c.id === cleaned);
    return cat ? { id: cat.id, label: cat.label } : null;
  }

  if (CATEGORY_LABELS.has(cleaned)) {
    const cat = CATEGORIES.find((c) => c.label.toLowerCase() === cleaned);
    return cat ? { id: cat.id, label: cat.label } : null;
  }

  return null;
}

export function normalizeLevel(input) {
  if (!input) return null;
  const cleaned = String(input).trim().toLowerCase();
  if (!cleaned) return null;

  if (LEVEL_IDS.has(cleaned)) {
    const level = LEVELS.find((l) => l.id === cleaned);
    return level ? { id: level.id, label: level.label } : null;
  }

  const levelByLabel = LEVELS.find((l) => l.label.toLowerCase() === cleaned);
  if (levelByLabel) return { id: levelByLabel.id, label: levelByLabel.label };

  return null;
}

export function validateCategorySubject(categoryId, subjectId) {
  if (!categoryId && !subjectId) return { valid: true };

  const subject = SUBJECT_BY_ID.get(subjectId);
  if (!subject && subjectId) {
    return { valid: false, error: `Unknown subject: ${subjectId}` };
  }

  if (categoryId && subject) {
    if (subject.categoryId !== categoryId) {
      const category = CATEGORIES.find((c) => c.id === categoryId);
      return {
        valid: false,
        error: `Subject "${subject.label}" does not belong to category "${category?.label || categoryId}"`,
      };
    }
  }

  return { valid: true };
}

export function getTaxonomy() {
  return {
    categories: CATEGORIES,
    subjects: SUBJECTS,
    levels: LEVELS,
  };
}

export function getSubjectById(id) {
  return SUBJECT_BY_ID.get(id) || null;
}

export function getCategoryById(id) {
  return CATEGORIES.find((c) => c.id === id) || null;
}

export function getSubjectsByCategory(categoryId) {
  return SUBJECTS.filter((s) => s.categoryId === categoryId);
}

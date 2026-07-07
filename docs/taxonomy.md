# Subject and Category Taxonomy Rules

This document outlines the rules, structures, and guidelines for the subject taxonomy system in EduVault. Standardizing taxonomy terms ensures consistency across resource uploads, imports, metadata storage, and marketplace search filters.

## Core Taxonomy Components

The taxonomy is divided into three key elements:
1. **Categories**: Major domains grouping related educational areas (e.g., Academic, Professional, Test Preparation).
2. **Subjects**: Fields of study belonging to a category (e.g., Mathematics, Science, Engineering, Law).
3. **Levels**: Target proficiency or difficulty levels (e.g., Beginner, Intermediate, Advanced, All Levels).

---

## Canonical Lists

### Categories
- `academic` (Academic)
- `professional` (Professional)
- `skills` (Skills & Crafts)
- `test-prep` (Test Preparation)
- `research` (Research)

### Subjects (and their Parent Categories)
| Subject ID | Subject Label | Parent Category ID | Aliases / Keywords |
| :--- | :--- | :--- | :--- |
| `mathematics` | Math | `academic` | maths, mathematics, algebra, calculus, geometry, trigonometry, statistics |
| `science` | Science | `academic` | general science, integrated science, basic science |
| `physics` | Physics | `academic` | physics |
| `chemistry` | Chemistry | `academic` | chemistry |
| `biology` | Biology | `academic` | biology |
| `law` | Law | `academic` | law, legal, jurisprudence |
| `technology` | Technology | `academic` | tech, it, information technology, computer science, computing, programming |
| `business` | Business | `academic` | business, commerce, entrepreneurship, management, accounting, finance, economics |
| `medicine` | Medicine | `academic` | medicine, medical, nursing, health, healthcare, clinical |
| `pharmacy` | Pharmacy | `academic` | pharmacy, pharmaceutical |
| `engineering` | Engineering | `academic` | engineering, engineer |
| `arts` | Arts | `academic` | arts, art, fine arts, visual arts, performing arts, music, theatre, drama |
| `social-sciences`| Social Sciences | `academic` | social sciences, social science, sociology, psychology, political science, anthropology, geography, history |
| `humanities` | Humanities | `academic` | humanities, philosophy, literature, religious studies, theology |
| `education` | Education | `academic` | education, teaching, pedagogy, curriculum |
| `languages` | Languages | `academic` | language, english, french, spanish, foreign language, linguistics |
| `certification` | Certification | `professional` | certification, certificate, professional certification |
| `test-prep` | Test Preparation | `test-prep` | test prep, exam prep, sat, act, gre, gmat, toefl, ielts |

### Levels
- `beginner` (Beginner)
- `intermediate` (Intermediate)
- `advanced` (Advanced)
- `all-levels` (All Levels)

---

## Mapping and Normalization Rules

To prevent spelling and casing issues, the system normalizes taxonomy inputs during resource creation, import, and search querying.

1. **Direct ID Lookup**: Inputs matching a canonical ID exactly (e.g., `social-sciences`) resolve directly.
2. **Label Matching**: Case-insensitive matches against labels (e.g., `Math` or `math`) map to the canonical ID (`mathematics`).
3. **Alias Matching**: Any string matching an alias (e.g., `algebra` or `nursing`) maps to the parent subject (e.g., `mathematics` or `medicine`).
4. **Casing & Trimming**: Leading and trailing whitespaces are automatically stripped, and searches are case-insensitive.

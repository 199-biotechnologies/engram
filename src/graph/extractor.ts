/**
 * Entity extraction from text using heuristics
 * No external APIs - pure local processing
 */

export interface ExtractedEntity {
  name: string;
  type: "person" | "place" | "concept" | "event" | "organization";
  confidence: number;
  span: { start: number; end: number };
}

// Common words that look like names but aren't (including verbs, adjectives, common nouns)
const STOPWORDS = new Set([
  // Articles, conjunctions, prepositions
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "is", "was", "are", "were", "been",
  "be", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "must", "shall", "can", "need",
  // Pronouns
  "this", "that", "these", "those", "i", "you", "he", "she", "it",
  "we", "they", "what", "which", "who", "whom", "whose", "where",
  "when", "why", "how", "all", "each", "every", "both", "few", "more",
  "most", "other", "some", "such", "no", "not", "only", "same", "so",
  "than", "too", "very", "just", "also", "now", "here", "there", "then",
  // Conjunctions
  "if", "because", "while", "although", "though", "after", "before",
  "since", "until", "unless", "however", "therefore", "thus", "hence",
  // Days and months
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december",
  // Time words
  "today", "tomorrow", "yesterday", "morning", "afternoon", "evening", "night",
  // Common verbs (often capitalized at sentence start)
  "said", "says", "told", "asked", "replied", "answered", "mentioned",
  "think", "know", "believe", "feel", "want", "need", "like", "love",
  "crashed", "gets", "getting", "got", "planning", "planned", "plans",
  "working", "worked", "works", "going", "went", "gone", "coming", "came",
  "looking", "looked", "looks", "trying", "tried", "tries", "using", "used",
  "making", "made", "makes", "taking", "took", "takes", "giving", "gave",
  "seeing", "saw", "seen", "being", "having", "doing", "saying", "getting",
  "finding", "found", "keeping", "kept", "letting", "let", "putting", "put",
  "running", "ran", "calling", "called", "moving", "moved", "living", "lived",
  "starting", "started", "seems", "seemed", "showing", "showed", "hearing",
  "playing", "played", "standing", "stood", "understanding", "understood",
  "turning", "turned", "following", "followed", "watching", "watched",
  "adding", "added", "changing", "changed", "writing", "wrote", "reading",
  "learning", "learned", "growing", "grew", "opening", "opened", "walking",
  "winning", "won", "offering", "offered", "remembering", "remembered",
  "considering", "considered", "appearing", "appeared", "buying", "bought",
  "waiting", "waited", "serving", "served", "dying", "died", "sending", "sent",
  "building", "built", "staying", "stayed", "falling", "fell", "cutting", "cut",
  "reaching", "reached", "killing", "killed", "raising", "raised", "passing",
  "selling", "sold", "deciding", "decided", "returning", "returned",
  // Common adjectives (often capitalized at sentence start)
  "good", "bad", "great", "small", "large", "big", "little", "old", "young",
  "new", "first", "last", "long", "short", "high", "low", "right", "wrong",
  "next", "early", "late", "hard", "easy", "clear", "full", "empty", "ready",
  "sure", "open", "closed", "free", "busy", "hot", "cold", "warm", "cool",
  "fast", "slow", "strong", "weak", "deep", "wide", "near", "far", "dark",
  "light", "heavy", "simple", "complex", "real", "true", "false", "best",
  "worst", "happy", "sad", "angry", "afraid", "sorry", "glad", "nice",
  "fine", "okay", "different", "similar", "same", "special", "important",
  "interesting", "beautiful", "wonderful", "terrible", "amazing", "awesome",
  // Common nouns (sentence starters)
  "people", "time", "year", "years", "way", "day", "days", "man", "woman",
  "child", "children", "world", "life", "hand", "part", "place", "case",
  "week", "weeks", "company", "system", "program", "question", "work",
  "government", "number", "point", "home", "water", "room", "mother",
  "area", "money", "story", "fact", "month", "months", "lot", "right",
  "study", "book", "books", "eye", "eyes", "job", "word", "words",
  "business", "issue", "issues", "side", "kind", "head", "house", "service",
  "friend", "friends", "power", "hour", "hours", "game", "line", "end",
  "member", "members", "law", "car", "city", "community", "name", "names",
  "team", "minute", "minutes", "idea", "ideas", "body", "information",
  "back", "parent", "parents", "face", "others", "level", "office", "door",
  "health", "person", "art", "war", "history", "party", "result", "change",
  "reason", "research", "girl", "guy", "moment", "air", "teacher", "force",
]);

// Common titles that precede names
const TITLES = ["mr", "mrs", "ms", "miss", "dr", "prof", "sir", "lady", "lord"];

// Organization suffixes and keywords
const ORG_SUFFIXES = [
  "inc", "inc.", "corp", "corp.", "corporation", "llc", "llp", "ltd", "ltd.",
  "limited", "co", "co.", "company", "companies", "group", "holdings",
  "partners", "partnership", "associates", "foundation", "institute",
  "university", "college", "school", "hospital", "clinic", "bank",
  "capital", "ventures", "labs", "laboratory", "laboratories",
  "technologies", "tech", "software", "systems", "solutions", "services",
  "industries", "international", "global", "worldwide", "enterprises",
];

// Well-known organizations (case-insensitive matching)
// Note: Avoid short words that could match common English words (e.g., "WHO")
const KNOWN_ORGANIZATIONS = new Set([
  "goldman sachs", "morgan stanley", "jp morgan", "jpmorgan", "citibank",
  "bank of america", "wells fargo", "barclays", "deutsche bank", "hsbc",
  "credit suisse", "ubs", "blackrock", "blackstone", "kkr", "carlyle",
  "apollo global", "bridgewater", "citadel", "two sigma", "renaissance technologies",
  "google", "alphabet", "microsoft", "apple", "amazon", "meta", "facebook",
  "netflix", "tesla", "nvidia", "intel", "amd", "ibm", "oracle", "salesforce",
  "adobe", "spotify", "uber", "lyft", "airbnb", "stripe", "square", "paypal",
  "twitter", "x corp", "linkedin", "snapchat", "tiktok", "bytedance",
  "openai", "anthropic", "deepmind", "cohere", "stability ai", "midjourney",
  "199 biotechnologies", "199 bio",
  "harvard university", "stanford university", "yale university", "princeton university",
  "columbia university", "oxford university", "cambridge university",
  "mit", "caltech", "nyu", "ucla", "usc", "berkeley",
  "fbi", "cia", "nsa", "nasa", "fda", "sec", "fcc", "epa", "doj",
  "united nations", "world bank", "imf", "nato", "european union",
  "red cross", "unicef", "greenpeace", "amnesty international",
  "new york times", "washington post", "wall street journal", "bbc", "cnn",
  "nbc", "abc news", "cbs news", "fox news", "reuters", "associated press", "bloomberg",
]);

// Words that look like names but aren't (nationalities, religions, etc.)
const NOT_PERSON_NAMES = new Set([
  "russian", "american", "british", "chinese", "japanese", "german", "french",
  "italian", "spanish", "indian", "brazilian", "mexican", "canadian", "australian",
  "muslim", "christian", "jewish", "hindu", "buddhist", "atheist", "catholic",
  "protestant", "orthodox", "sunni", "shia", "sikh", "jain",
  "asian", "european", "african", "latin", "caucasian", "middle eastern",
]);

// Common places (US states, major cities, countries)
const KNOWN_PLACES = new Set([
  "california", "new york", "texas", "florida", "washington", "massachusetts",
  "colorado", "illinois", "pennsylvania", "ohio", "georgia", "michigan",
  "san francisco", "los angeles", "seattle", "boston", "chicago", "miami",
  "london", "paris", "tokyo", "singapore", "hong kong", "dubai", "berlin",
  "sydney", "toronto", "vancouver", "amsterdam", "zurich", "geneva",
  "usa", "uk", "china", "japan", "germany", "france", "india", "canada",
  "australia", "brazil", "mexico", "russia", "spain", "italy", "switzerland",
]);

// Relationship words that often precede person mentions
const RELATION_WORDS = [
  "brother", "sister", "mother", "father", "mom", "dad", "mum",
  "son", "daughter", "wife", "husband", "partner", "boyfriend", "girlfriend",
  "uncle", "aunt", "cousin", "nephew", "niece", "grandmother", "grandfather",
  "grandma", "grandpa", "friend", "colleague", "boss", "ex", "fiancé", "fiancée",
];

export class EntityExtractor {
  /**
   * Extract all entities from text
   */
  extractAll(text: string): ExtractedEntity[] {
    const entities: ExtractedEntity[] = [];

    // Extract organizations FIRST (higher priority)
    const orgs = this.extractOrganizations(text);
    entities.push(...orgs);

    // Track organization names to avoid re-extracting as persons
    const orgNames = new Set(orgs.map((o) => o.name.toLowerCase()));

    // Extract persons (excluding already-found orgs)
    const persons = this.extractPersons(text).filter(
      (p) => !orgNames.has(p.name.toLowerCase())
    );
    entities.push(...persons);

    // First: filter out entities with bad prefixes/suffixes
    const badSuffixes = ["managing", "as", "last", "and", "or", "the", "a", "an", "for", "with"];
    const badPrefixes = ["he", "she", "they", "my", "his", "her", "the", "a", "an", "joined"];

    const cleanEntities = entities.filter((entity) => {
      const words = entity.name.toLowerCase().split(/\s+/);
      const lastWord = words[words.length - 1];
      const firstWord = words[0];
      if (badSuffixes.includes(lastWord)) return false;
      if (badPrefixes.includes(firstWord)) return false;
      return true;
    });

    // Deduplicate by name, preferring higher confidence and orgs over persons
    const seen = new Map<string, ExtractedEntity>();
    for (const entity of cleanEntities) {
      const key = entity.name.toLowerCase();
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, entity);
      } else if (entity.type === "organization" && existing.type === "person") {
        // Prefer org over person
        seen.set(key, entity);
      } else if (entity.confidence > existing.confidence && entity.type === existing.type) {
        seen.set(key, entity);
      }
    }

    // Remove entities that are proper substrings of other entities with same type
    const result = Array.from(seen.values());
    return result.filter((entity) => {
      const key = entity.name.toLowerCase();
      for (const other of result) {
        const otherKey = other.name.toLowerCase();
        if (otherKey !== key && other.type === entity.type) {
          // If this entity is a prefix of another (longer) entity, keep the shorter one
          // unless the longer one has much higher confidence
          if (otherKey.startsWith(key + " ") && other.confidence > entity.confidence + 0.1) {
            return false;
          }
        }
      }
      return true;
    });
  }

  /**
   * Extract organizations from text
   */
  extractOrganizations(text: string): ExtractedEntity[] {
    const results: ExtractedEntity[] = [];
    const foundNames = new Set<string>();

    // Pattern 1: Check for known organizations
    for (const orgName of KNOWN_ORGANIZATIONS) {
      const pattern = new RegExp(`\\b${this.escapeRegex(orgName)}\\b`, "gi");
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const name = match[0];
        const key = name.toLowerCase();
        if (!foundNames.has(key)) {
          foundNames.add(key);
          results.push({
            name,
            type: "organization",
            confidence: 0.95,
            span: { start: match.index, end: match.index + name.length },
          });
        }
      }
    }

    // Pattern 2: Capitalized word(s) followed by org suffixes
    // Allow single word + suffix (e.g., "Acme Corporation")
    // Use case-sensitive matching for proper nouns, handle suffix case separately
    const suffixPatternStr = ORG_SUFFIXES.map(s =>
      `${s.charAt(0).toUpperCase()}${s.slice(1)}|${s.toLowerCase()}`
    ).join("|");
    const suffixPattern = new RegExp(
      `(?:^|[^A-Za-z])([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)*)\\s+(${suffixPatternStr})(?=\\s|,|\\.|\\)|$)`,
      "g"
    );
    let match;
    while ((match = suffixPattern.exec(text)) !== null) {
      const baseName = match[1].trim();
      const suffix = match[2].trim();
      const fullName = `${baseName} ${suffix}`;
      const key = fullName.toLowerCase();

      // Skip common adjective+suffix combos
      const firstWord = baseName.split(/\s+/)[0].toLowerCase();
      if (NOT_PERSON_NAMES.has(firstWord)) continue;
      // Skip single words that are not proper nouns
      if (STOPWORDS.has(firstWord)) continue;

      if (!foundNames.has(key)) {
        foundNames.add(key);
        results.push({
          name: fullName,
          type: "organization",
          confidence: 0.85,
          span: { start: match.index, end: match.index + fullName.length },
        });
      }
    }

    // Pattern 3: "works at/for X", "joined X" - only extract multi-word org names
    // Single-word orgs should be in KNOWN_ORGANIZATIONS
    // Use case-sensitive matching for proper nouns (no 'i' flag)
    const workPattern = /(?:works?\s+(?:at|for)|joined|employed\s+(?:at|by)|hired\s+by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})(?=\s+[a-z]|\s*[,.]|\s*$)/g;

    while ((match = workPattern.exec(text)) !== null) {
      const name = match[1].trim();
      const key = name.toLowerCase();
      const words = name.split(/\s+/);

      // Skip if first word is a stopword or nationality/religion
      if (STOPWORDS.has(words[0].toLowerCase()) ||
          NOT_PERSON_NAMES.has(words[0].toLowerCase())) {
        continue;
      }

      if (!foundNames.has(key)) {
        foundNames.add(key);
        results.push({
          name,
          type: "organization",
          confidence: 0.7,
          span: { start: match.index, end: match.index + match[0].length },
        });
      }
    }

    return results;
  }

  /**
   * Escape special regex characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Extract person names from text using heuristics
   */
  extractPersons(text: string): ExtractedEntity[] {
    const persons: ExtractedEntity[] = [];

    // Pattern 1: Capitalized words (potential names)
    persons.push(...this.extractCapitalizedNames(text));

    // Pattern 2: Possessive patterns ("X's brother", "my friend X")
    persons.push(...this.extractFromPossessives(text));

    // Pattern 3: Relation patterns ("her brother", "my mom")
    persons.push(...this.extractFromRelations(text));

    return persons;
  }

  /**
   * Extract capitalized words that look like names
   */
  private extractCapitalizedNames(text: string): ExtractedEntity[] {
    const results: ExtractedEntity[] = [];

    // Match capitalized words not at sentence start
    // This regex finds sequences of capitalized words
    const pattern = /(?<=[.!?]\s+|^)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)|(?<=[a-z]\s)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g;

    let match;
    while ((match = pattern.exec(text)) !== null) {
      const name = (match[1] || match[2]).trim();
      const words = name.split(/\s+/);

      // Filter out stopwords, nationality/religion words, places, and single common words
      const cleanWords = words.filter(
        (w) => !STOPWORDS.has(w.toLowerCase()) &&
               !NOT_PERSON_NAMES.has(w.toLowerCase()) &&
               !KNOWN_PLACES.has(w.toLowerCase()) &&
               w.length > 1
      );

      if (cleanWords.length === 0) continue;

      const cleanName = cleanWords.join(" ");

      // Skip if it's just a common word
      if (cleanWords.length === 1 && cleanWords[0].length < 4) continue;

      // Higher confidence for multi-word names
      const confidence = cleanWords.length >= 2 ? 0.8 : 0.5;

      results.push({
        name: cleanName,
        type: "person",
        confidence,
        span: { start: match.index, end: match.index + match[0].length },
      });
    }

    return results;
  }

  /**
   * Extract names from possessive patterns like "Sarah's brother"
   */
  private extractFromPossessives(text: string): ExtractedEntity[] {
    const results: ExtractedEntity[] = [];

    // Match "Name's something"
    const pattern = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)'s\s+(\w+)/g;

    let match;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1].trim();
      const following = match[2].toLowerCase();

      // Higher confidence if followed by a relationship word
      const isRelation = RELATION_WORDS.includes(following);
      const confidence = isRelation ? 0.95 : 0.7;

      if (!STOPWORDS.has(name.toLowerCase())) {
        results.push({
          name,
          type: "person",
          confidence,
          span: { start: match.index, end: match.index + name.length },
        });
      }

      // If followed by relationship word, the whole thing might reference another person
      // e.g., "Sarah's brother" - we create a derived entity
      if (isRelation) {
        results.push({
          name: `${name}'s ${following}`,
          type: "person",
          confidence: 0.6,
          span: { start: match.index, end: match.index + match[0].length },
        });
      }
    }

    return results;
  }

  /**
   * Extract from relationship patterns like "her brother", "my friend John"
   */
  private extractFromRelations(text: string): ExtractedEntity[] {
    const results: ExtractedEntity[] = [];

    // Pattern: possessive + relation word + optional name
    const pronouns = ["my", "his", "her", "their", "our"];
    const relationPattern = new RegExp(
      `(${pronouns.join("|")})\\s+(${RELATION_WORDS.join("|")})(?:\\s+([A-Z][a-z]+))?`,
      "gi"
    );

    let match;
    while ((match = relationPattern.exec(text)) !== null) {
      const pronoun = match[1];
      const relation = match[2];
      const name = match[3];

      if (name && !STOPWORDS.has(name.toLowerCase())) {
        // Explicit name mentioned
        results.push({
          name,
          type: "person",
          confidence: 0.9,
          span: {
            start: match.index + match[0].length - name.length,
            end: match.index + match[0].length,
          },
        });
      }
    }

    return results;
  }

  /**
   * Extract relationship mentions (not entities, but useful for graph)
   */
  extractRelationships(text: string): Array<{
    subject: string;
    relation: string;
    object: string;
    confidence: number;
  }> {
    const relationships: Array<{
      subject: string;
      relation: string;
      object: string;
      confidence: number;
    }> = [];

    // Pattern: "X's [relation]" implies relationship
    const possessivePattern = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)'s\s+(\w+)/g;

    let match;
    while ((match = possessivePattern.exec(text)) !== null) {
      const subject = match[1].trim();
      const relWord = match[2].toLowerCase();

      if (RELATION_WORDS.includes(relWord)) {
        relationships.push({
          subject,
          relation: relWord,
          object: `${subject}'s ${relWord}`, // placeholder name
          confidence: 0.7,
        });
      }
    }

    return relationships;
  }
}

// Singleton instance
export const entityExtractor = new EntityExtractor();

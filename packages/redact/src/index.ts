// Scrubs secrets and personal data from captured prompts before they are
// stored or sent to a test model. The same code runs in the CLI and SDKs
// (before data leaves the machine) and on the server (per-project policy).
//
// Placeholders are consistent within one Redactor: the same email always
// becomes <EMAIL_1>, so a redacted conversation keeps its meaning.

export type RedactionCategory =
  | "private_key"
  | "jwt"
  | "api_key"
  | "secret_assignment"
  | "email"
  | "card"
  | "phone"
  | "ip";

export const ALL_CATEGORIES: readonly RedactionCategory[] = [
  "private_key",
  "jwt",
  "api_key",
  "secret_assignment",
  "email",
  "card",
  "phone",
  "ip",
];

export type CustomPattern = { name: string; pattern: string; flags?: string };

export type RedactionPolicy = {
  categories?: readonly RedactionCategory[];
  custom?: readonly CustomPattern[];
};

type Rule = {
  label: string;
  regex: RegExp;
  /** Which capture group holds the sensitive part (0 = whole match). */
  group?: number;
  accept?: (value: string) => boolean;
};

const PLACEHOLDER = /^<[A-Z_]+_\d+>$/;

function luhnValid(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function validIpv4(value: string) {
  const parts = value.split(".").map(Number);
  if (parts.some((part) => part > 255)) return false;
  // Loopback and unspecified addresses carry no personal information.
  return !(value.startsWith("127.") || value === "0.0.0.0");
}

const phoneDigits = (value: string) => value.replace(/\D/g, "").length;

const BUILT_IN: Record<RedactionCategory, Rule[]> = {
  private_key: [
    {
      label: "PRIVATE_KEY",
      regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    },
  ],
  jwt: [{ label: "JWT", regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g }],
  api_key: [
    {
      label: "SECRET",
      regex: new RegExp(
        [
          String.raw`\bsk-ant-[A-Za-z0-9_-]{20,}`,
          String.raw`\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{20,}`,
          String.raw`\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}`,
          String.raw`\bAKIA[0-9A-Z]{16}\b`,
          String.raw`\bgh[pousr]_[A-Za-z0-9]{36,}\b`,
          String.raw`\bgithub_pat_[A-Za-z0-9_]{40,}`,
          String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
          String.raw`\bAIza[0-9A-Za-z_-]{35}\b`,
          String.raw`\blucid_(?:live|test)_[A-Za-z0-9]{16,}`,
        ].join("|"),
        "g",
      ),
    },
    { label: "SECRET", regex: /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/g, group: 1 },
  ],
  secret_assignment: [
    {
      label: "SECRET",
      // Not \b: "DB_PASSWORD" has no word boundary before PASSWORD.
      regex: /(?<![A-Za-z0-9])(?:api[_-]?key|secret|token|passw(?:or)?d|pwd)["']?\s*[:=]\s*["']?([^\s"',;]{8,})/gi,
      group: 1,
    },
  ],
  email: [{ label: "EMAIL", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g }],
  card: [{ label: "CARD", regex: /\b(?:\d[ -]?){12,18}\d\b/g, accept: luhnValid }],
  phone: [
    {
      label: "PHONE",
      // Only shapes that are clearly phone numbers: a +country code, an
      // (area) code, or 555-123-4567. Space-separated digit groups are too
      // often ids or card-like numbers to guess at.
      regex: /(?<![\w+.-])(?:\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]?\d{2,4}){1,3}|\(\d{3}\)[\s.-]?\d{3}[\s.-]?\d{4}|\d{3}[.-]\d{3}[.-]\d{4})(?![\w.-]|\s\d)/g,
      accept: (value) => {
        const digits = phoneDigits(value);
        return digits >= 10 && digits <= 15;
      },
    },
  ],
  ip: [{ label: "IP", regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, accept: validIpv4 }],
};

export type RedactionCounts = Partial<Record<string, number>>;

export class Redactor {
  private readonly rules: Rule[];
  private readonly placeholders = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  readonly counts: RedactionCounts = {};

  constructor(policy: RedactionPolicy = {}) {
    const categories = policy.categories ?? ALL_CATEGORIES;
    // Order matters: multi-line keys and JWTs first, so a shorter pattern never
    // consumes part of a longer secret.
    this.rules = ALL_CATEGORIES.filter((category) => categories.includes(category)).flatMap(
      (category) => BUILT_IN[category],
    );
    for (const custom of policy.custom ?? []) {
      const flags = custom.flags?.includes("g") ? custom.flags : `${custom.flags ?? ""}g`;
      this.rules.push({ label: custom.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_"), regex: new RegExp(custom.pattern, flags) });
    }
  }

  private placeholderFor(label: string, value: string) {
    const key = `${label}\u0000${value}`;
    const existing = this.placeholders.get(key);
    if (existing) return existing;
    const next = (this.counters.get(label) ?? 0) + 1;
    this.counters.set(label, next);
    const placeholder = `<${label}_${next}>`;
    this.placeholders.set(key, placeholder);
    this.counts[label] = (this.counts[label] ?? 0) + 1;
    return placeholder;
  }

  text(input: string): string {
    let output = input;
    for (const rule of this.rules) {
      rule.regex.lastIndex = 0;
      output = output.replace(rule.regex, (match: string, ...groups: unknown[]) => {
        const sensitive = rule.group ? (groups[rule.group - 1] as string | undefined) : match;
        if (!sensitive || PLACEHOLDER.test(sensitive)) return match;
        if (rule.accept && !rule.accept(sensitive)) return match;
        const placeholder = this.placeholderFor(rule.label, sensitive);
        return rule.group ? match.replace(sensitive, placeholder) : placeholder;
      });
    }
    return output;
  }

  /** Deep-redacts every string in a JSON-like value. Object keys are kept. */
  value<T>(input: T): T {
    if (typeof input === "string") return this.text(input) as T;
    if (Array.isArray(input)) return input.map((item) => this.value(item)) as T;
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) out[key] = this.value(item);
      return out as T;
    }
    return input;
  }
}

export function redactText(input: string, policy?: RedactionPolicy) {
  const redactor = new Redactor(policy);
  return { text: redactor.text(input), counts: redactor.counts };
}

export function redactValue<T>(input: T, policy?: RedactionPolicy) {
  const redactor = new Redactor(policy);
  return { value: redactor.value(input), counts: redactor.counts };
}

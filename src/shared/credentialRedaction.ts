/** Credential hygiene for text CanvasTTY itself sends to outside services (the Jev task text in this
 *  layer; the assistant and account-pool handoffs later). It is not a data-class check: it runs in every
 *  data-check mode, Off included, and nothing can switch it off.
 *
 *  It never touches text a person or an agent writes to the agent the person chose (prompts,
 *  send_to_agent, the control CLI's send): CanvasTTY only carries that text, and filtering it would break
 *  real tasks such as "put this key in .env".
 *
 *  Each match becomes `<redacted:kind>`. Masking is idempotent: a masked marker is never masked again. */

type Rule = { kind: string; pattern: RegExp; replace?: (match: string, ...groups: string[]) => string };

const marker = (kind: string): string => `<redacted:${kind}>`;
const NOT_MASKED = "(?!<redacted:)";

const RULES: readonly Rule[] = [
  // PEM private-key blocks, including a block cut off before its END line.
  { kind: "private-key", pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/gu },
  // The same token shapes the repository secret audit checks (scripts/audit-secrets.mjs).
  { kind: "anthropic", pattern: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{16,}/gu },
  { kind: "openai", pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/gu },
  { kind: "github", pattern: /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu },
  { kind: "slack", pattern: /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{16,}/gu },
  { kind: "aws", pattern: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![0-9A-Z])/gu },
  { kind: "jwt", pattern: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu },
  { kind: "xai", pattern: /(?<![A-Za-z0-9])xai-[A-Za-z0-9_-]{20,}/gu },
  { kind: "google", pattern: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/gu },
  // Header values: `Authorization: Bearer …`, `Authorization: Basic …`, and a bare `Bearer …`.
  { kind: "authorization", pattern: new RegExp(`(\\bAuthorization\\s*[:=]\\s*["']?)${NOT_MASKED}(?:(?:Bearer|Basic|Token|Bot)\\s+)?${NOT_MASKED}[^\\s"'<>]{4,}`, "giu"), replace: (_match, prefix) => `${prefix}${marker("authorization")}` },
  { kind: "bearer", pattern: new RegExp(`\\bBearer\\s+${NOT_MASKED}[A-Za-z0-9._~+/=-]{8,}`, "gu"), replace: () => `Bearer ${marker("bearer")}` },
  // URL userinfo (`https://user:secret@host`, or a token alone as the user).
  { kind: "url-credentials", pattern: /(\b[a-z][a-z0-9+.-]{1,20}:\/\/)([^\s/@<>"']+)@/giu,
    replace: (match, scheme, userinfo) => userinfo.includes(":") || userinfo.length >= 16 ? `${scheme}${marker("url-credentials")}@` : match },
  // Query values of secret-looking parameters.
  { kind: "url-secret", pattern: new RegExp(`([?&](?:[A-Za-z0-9]+[_-])*(?:token|key|secret|password|sig|signature)=)${NOT_MASKED}[^&#\\s"'<>]+`, "giu"), replace: (_match, prefix) => `${prefix}${marker("url-secret")}` },
  // Assignments whose name contains TOKEN / SECRET / PASSWORD / PASSWD / CREDENTIAL(S) (any prefix: PGPASSWORD,
  // GITHUBTOKEN, db.password) or ends in KEY (a camel-case Key, an upper-case KEY, or a separate key segment,
  // so `monkey` and `keyboard` stay). The name may be quoted (JSON, YAML, Python) and the separator is `:`, `=`
  // or `=>`. Quoted values may contain spaces; bare values end at whitespace or a separator.
  // Every repetition is bounded: a long run of name-like text must not be tried against itself at every boundary.
  { kind: "assignment", pattern: new RegExp(`(["']?\\b(?:[A-Za-z0-9_.-]{0,100}(?:[Tt]oken|TOKEN|[Ss]ecret|SECRET|[Pp]assw(?:or)?d|PASSW(?:OR)?D|[Cc]redentials?|CREDENTIALS?)|(?:[A-Za-z0-9]{1,40}[_.-]){0,8}(?:[A-Za-z0-9]{0,40}Key|[A-Z0-9]{1,40}KEY|(?:[Aa][Pp][Ii][_-]?)?(?:key|KEY)))(?![A-Za-z0-9])["']?\\s*(?:=>|[:=])\\s*)(?:"${NOT_MASKED}[^"\\r\\n]{4,}"|'${NOT_MASKED}[^'\\r\\n]{4,}'|\`${NOT_MASKED}[^\`\\r\\n]{4,}\`|${NOT_MASKED}[^\\s"'\`<>,;]{4,})`, "gu"),
    replace: (_match, prefix) => `${prefix}${marker("assignment")}` },
  // Anything else that looks like a random secret: a long run that mixes upper case, lower case and
  // digits with high entropy. Pure hex (a commit SHA) has no upper case and survives; paths never
  // form one run because `/` and `.` end it.
  { kind: "high-entropy", pattern: /(?<![A-Za-z0-9+=_-])[A-Za-z0-9+=_-]{32,}(?![A-Za-z0-9+=_-])/gu,
    replace: (match) => looksRandom(match) ? marker("high-entropy") : match }
];

function looksRandom(value: string): boolean {
  const upper = value.match(/[A-Z]/gu)?.length ?? 0, lower = value.match(/[a-z]/gu)?.length ?? 0, digits = value.match(/[0-9]/gu)?.length ?? 0;
  if (upper < 2 || lower < 2 || digits < 2) return false;
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) { const p = count / value.length; entropy -= p * Math.log2(p); }
  return entropy >= 4.2;
}

export function redactCredentials(text: string): { text: string; count: number } {
  if (typeof text !== "string" || text.length === 0) return { text: typeof text === "string" ? text : "", count: 0 };
  let count = 0, result = text;
  for (const rule of RULES) {
    result = result.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      // Arguments after the match: the capture groups, then the numeric offset and the whole input.
      const end = rest.findIndex(value => typeof value === "number");
      const groups = (end < 0 ? [] : rest.slice(0, end)).map(value => typeof value === "string" ? value : "");
      const replaced = rule.replace ? rule.replace(match, ...groups) : marker(rule.kind);
      if (replaced !== match) count++;
      return replaced;
    });
  }
  return { text: result, count };
}

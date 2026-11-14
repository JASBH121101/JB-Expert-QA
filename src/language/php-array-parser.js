function parserError(message, offset) {
  return new SyntaxError("Unsupported PHP translation resource at offset " + offset + ": " + message);
}

class StaticPhpArrayParser {
  constructor(source) {
    this.source = source.replace(/^\uFEFF/, "");
    this.offset = 0;
  }

  skipTrivia() {
    while (this.offset < this.source.length) {
      const rest = this.source.slice(this.offset);
      const whitespace = rest.match(/^\s+/);
      if (whitespace) { this.offset += whitespace[0].length; continue; }
      if (rest.startsWith("<?php")) { this.offset += 5; continue; }
      if (rest.startsWith("?>")) { this.offset += 2; continue; }
      if (rest.startsWith("//") || rest.startsWith("#")) {
        const end = this.source.indexOf("\n", this.offset);
        this.offset = end < 0 ? this.source.length : end + 1;
        continue;
      }
      if (rest.startsWith("/*")) {
        const end = this.source.indexOf("*/", this.offset + 2);
        if (end < 0) throw parserError("Unclosed block comment", this.offset);
        this.offset = end + 2;
        continue;
      }
      break;
    }
  }

  expect(token) {
    this.skipTrivia();
    if (!this.source.startsWith(token, this.offset)) throw parserError("Expected " + JSON.stringify(token), this.offset);
    this.offset += token.length;
  }

  readString() {
    this.skipTrivia();
    const quote = this.source[this.offset];
    if (quote !== "'" && quote !== '"') throw parserError("Expected a quoted string", this.offset);
    this.offset++;
    let value = "";
    while (this.offset < this.source.length) {
      const char = this.source[this.offset++];
      if (char === quote) return value;
      if (char !== "\\") {
        if (quote === '"' && char === "$") throw parserError("Variable interpolation is not allowed", this.offset - 1);
        value += char;
        continue;
      }
      if (this.offset >= this.source.length) throw parserError("Incomplete escape sequence", this.offset);
      const escaped = this.source[this.offset++];
      if (quote === "'") {
        value += escaped === "'" || escaped === "\\" ? escaped : "\\" + escaped;
      } else {
        const translations = { n: "\n", r: "\r", t: "\t", v: "\v", e: "\x1B", f: "\f", "\\": "\\", '"': '"', "$": "$" };
        value += Object.hasOwn(translations, escaped) ? translations[escaped] : "\\" + escaped;
      }
    }
    throw parserError("Unclosed string literal", this.offset);
  }

  parseValue() {
    this.skipTrivia();
    const char = this.source[this.offset];
    if (char === "[") return this.parseArray();
    if (char === "'" || char === '"') return this.readString();
    const scalar = this.source.slice(this.offset).match(/^(true|false|null|-?[0-9]+(?:\.[0-9]+)?)(?=\s*[,\\]])/i);
    if (!scalar) throw parserError("Only literal strings, scalar values and nested arrays are supported", this.offset);
    this.offset += scalar[0].length;
    if (scalar[0].toLowerCase() === "true") return true;
    if (scalar[0].toLowerCase() === "false") return false;
    if (scalar[0].toLowerCase() === "null") return null;
    return Number(scalar[0]);
  }

  parseArray() {
    this.expect("[");
    const result = {};
    this.skipTrivia();
    while (this.source[this.offset] !== "]") {
      if (this.offset >= this.source.length) throw parserError("Unclosed array", this.offset);
      const key = this.readString();
      this.expect("=>");
      result[key] = this.parseValue();
      this.skipTrivia();
      if (this.source[this.offset] === ",") { this.offset++; this.skipTrivia(); continue; }
      if (this.source[this.offset] !== "]") throw parserError("Expected comma or closing bracket", this.offset);
    }
    this.offset++;
    return result;
  }

  parse() {
    this.skipTrivia();
    this.expect("return");
    const value = this.parseValue();
    this.skipTrivia();
    if (this.source[this.offset] === ";") this.offset++;
    this.skipTrivia();
    if (this.offset < this.source.length) throw parserError("Executable PHP after the returned value is not allowed", this.offset);
    if (!value || Array.isArray(value) || typeof value !== "object") throw parserError("The returned value must be an associative array", this.offset);
    return value;
  }
}

export function parsePhpTranslationArray(source) {
  if (typeof source !== "string" || source.length > 2_000_000) {
    throw new TypeError("PHP translation source must be a string no larger than 2 MB");
  }
  return new StaticPhpArrayParser(source).parse();
}

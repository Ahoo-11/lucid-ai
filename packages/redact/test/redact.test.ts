import { describe, expect, it } from "vitest";
import { Redactor, redactText, redactValue } from "../src/index";

describe("redact", () => {
  it("replaces common secret formats", () => {
    const input = [
      "anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
      "aws AKIAIOSFODNN7EXAMPLE",
      "gh ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "stripe sk_live_abcdefghijklmnop1234",
      "auth: Bearer abcdefghijklmnop.qrstuvwx",
    ].join("\n");
    const { text, counts } = redactText(input);
    expect(text).not.toMatch(/sk-ant|AKIA|ghp_|sk_live|abcdefghijklmnop\.qrstuvwx/);
    expect(text).toContain("Bearer <SECRET_");
    expect(counts.SECRET).toBe(5);
  });

  it("redacts the value of key=value secrets but keeps the key", () => {
    expect(redactText('DB_PASSWORD="hunter2hunter2"').text).toBe('DB_PASSWORD="<SECRET_1>"');
    expect(redactText("api_key: abcd1234efgh").text).toBe("api_key: <SECRET_1>");
  });

  it("keeps placeholders consistent across one conversation", () => {
    const redactor = new Redactor();
    expect(redactor.text("mail ana@example.com")).toBe("mail <EMAIL_1>");
    expect(redactor.text("cc bo@example.org and ana@example.com")).toBe("cc <EMAIL_2> and <EMAIL_1>");
  });

  it("only redacts card numbers that pass the Luhn check", () => {
    expect(redactText("card 4242 4242 4242 4242").text).toBe("card <CARD_1>");
    expect(redactText("order 1234 5678 9012 3456").text).toBe("order 1234 5678 9012 3456");
  });

  it("redacts phones with separators but not plain numbers or versions", () => {
    expect(redactText("call +1 415-555-0134 now").text).toBe("call <PHONE_1> now");
    expect(redactText("took 1234567890 ms, version 2.1.308").text).toBe("took 1234567890 ms, version 2.1.308");
  });

  it("redacts public IPs and leaves loopback", () => {
    expect(redactText("from 203.0.113.9 to 127.0.0.1").text).toBe("from <IP_1> to 127.0.0.1");
  });

  it("redacts private keys and JWTs whole", () => {
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3Nza\n-----END OPENSSH PRIVATE KEY-----";
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redactText(`${key} and ${jwt}`).text).toBe("<PRIVATE_KEY_1> and <JWT_1>");
  });

  it("respects the category policy and custom patterns", () => {
    const { text } = redactText("ana@example.com EMP-00423", {
      categories: ["api_key"],
      custom: [{ name: "employee id", pattern: "EMP-\\d{5}" }],
    });
    expect(text).toBe("ana@example.com <EMPLOYEE_ID_1>");
  });

  it("deep-redacts JSON values and keeps keys", () => {
    const { value } = redactValue({ messages: [{ role: "user", content: "I am ana@example.com" }], "ana@example.com": 1 });
    expect(value).toEqual({ messages: [{ role: "user", content: "I am <EMAIL_1>" }], "ana@example.com": 1 });
  });
});

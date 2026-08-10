// ─── Advertisement Pool ──────────────────────────────────────
const advertisements = [
  "@reactionbotupdate - 𝘋𝘪𝘴𝘤𝘰𝘷𝘦𝘳 𝘣𝘰𝘵𝘴, 𝘳𝘦𝘱𝘰𝘴, 𝘵𝘶𝘵𝘰𝘳𝘪𝘢𝘭𝘴, 𝘢𝘯𝘥 𝘶𝘴𝘦𝘧𝘶𝘭 𝘛𝘦𝘭𝘦𝘨𝘳𝘢𝘮 𝘵𝘰𝘰𝘭𝘴.",
  "@reactionbotupdate - 𝘎𝘦𝘵 𝘢𝘯𝘪𝘮𝘦, 𝘮𝘢𝘯𝘨𝘢, 𝘤𝘰𝘮𝘪𝘤 𝘶𝘱𝘥𝘢𝘵𝘦𝘴, 𝘢𝘯𝘥 𝘴𝘦𝘢𝘴𝘰𝘯𝘢𝘭 𝘳𝘦𝘭𝘦𝘢𝘴𝘦 𝘭𝘪𝘴𝘵𝘴.",
  "@reactionbotupdate - 𝘌𝘹𝘱𝘭𝘰𝘳𝘦 𝘦𝘮𝘰𝘵𝘪𝘰𝘯𝘢𝘭, 𝘪𝘯𝘴𝘱𝘪𝘳𝘪𝘯𝘨, 𝘢𝘯𝘥 𝘮𝘦𝘮𝘰𝘳𝘢𝘣𝘭𝘦 𝘢𝘯𝘪𝘮𝘦 𝘲𝘶𝘰𝘵𝘦𝘴.",
  "@reactionbotupdate - 𝘍𝘪𝘯𝘥 𝘯𝘦𝘸 𝘣𝘰𝘵 𝘱𝘳𝘰𝘫𝘦𝘤𝘵𝘴, 𝘴𝘰𝘶𝘳𝘤𝘦 𝘤𝘰𝘥𝘦, 𝘢𝘯𝘥 𝘩𝘰𝘴𝘵𝘪𝘯𝘨 𝘨𝘶𝘪𝘥𝘦𝘴.",
  "@reactionbotupdate - 𝘋𝘪𝘴𝘤𝘰𝘷𝘦𝘳 𝘦𝘱𝘪𝘤 𝘤𝘩𝘢𝘳𝘢𝘤𝘵𝘦𝘳𝘴, 𝘤𝘰𝘮𝘪𝘤𝘴, 𝘢𝘯𝘥 𝘧𝘢𝘯𝘥𝘰𝘮 𝘤𝘰𝘯𝘵𝘦𝘯𝘵.",
  "@reactionbotupdate - 𝘍𝘦𝘦𝘭 𝘵𝘩𝘦 𝘦𝘮𝘰𝘵𝘪𝘰𝘯𝘴 𝘣𝘦𝘩𝘪𝘯𝘥 𝘢𝘯𝘪𝘮𝘦 𝘵𝘩𝘳𝘰𝘶𝘨𝘩 𝘣𝘦𝘢𝘶𝘵𝘪𝘧𝘶𝘭 𝘲𝘶𝘰𝘵𝘦𝘴."
];

// ─── Public API ──────────────────────────────────────────────

export function getRandomAd() {
    return advertisements[Math.floor(Math.random() * advertisements.length)];
}

export function getAdFooter() {
    const ad = getRandomAd();
    return `\n\n✨ 𝗕𝘆: <b><a href="https://telegram.me/proto_is_back>pro to</a></b>\n<blockquote>${ad}</blockquote>`;
}

export function getAdCount() {
    return advertisements.length;
}

// ══════════════════════════════════════════════════════════════ END: ads.js

import {
    startMessage, helpMessage, aboutMessage, donateMessage, statsHeader,
    reactionsUpdated, reactionsReset, reactionsInvalid,
    pausedMessage, resumedMessage, notPausedMessage,
    broadcastStarted, broadcastDone, onlyOwnerMessage,
    onlyAdminMessage, groupOnlyMessage, pingMessage,
    adminPanelMessage
} from './constants.js';
import { getRandomPositiveReaction, splitEmojis, log } from './helper.js';
import { getAdFooter } from './ads.js';
import { Store } from './store.js';

// ══════════════════════════════════════════════════════════════
// IN-MEMORY STATE (runtime-only, not persisted)
// ══════════════════════════════════════════════════════════════

// NOTE: Persistent state (chats, reactions, paused, restricted, welcome,
//       goodbye, stats) lives in the Store. These are runtime-only:

const uniqueChats = new Set();   // Chat IDs seen this session
const reactionLog = [];          // Last 50 Reactions: [{chatId, emoji, timestamp}]
const rateLimitMap = {};         // chatId → { count, resetAt }
const chatNames = {};            // chatId → Chat Title (Cached)
const perChatRandomLevel = {};   // chatId → Random Level Override (0-10)
const lastBotMessage = {};       // chatId → last bot message_id (for cleanup)

const LOG_MAX = 50;
const RATE_LIMIT_MAX = 30;       // Max Reactions Per Minute Per Chat
const RATE_LIMIT_WINDOW = 60000; // 1 Minute
const BROADCAST_COOLDOWN = 60000; // 1 Minute Between Broadcasts
let lastBroadcastTime = 0;

// ══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════════

function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}ᴅ ${h % 24}ʜ ${m % 60}ᴍ`;
    if (h > 0) return `${h}ʜ ${m % 60}ᴍ ${s % 60}s`;
    if (m > 0) return `${m}ᴍ ${s % 60}s`;
    return `${s}s`;
}

function formatIST(date) {
    const d = date instanceof Date ? date : new Date(date);
    const ist = new Date(d.getTime() + (5 * 60 + 30) * 60 * 1000);
    const day = String(ist.getUTCDate()).padStart(2, '0');
    const month = ['𝖩𝖺𝗇', '𝖥𝖾𝖻', '𝖬𝖺𝗋', '𝖠𝗉𝗋', '𝖬𝖺𝗒', '𝖩𝗎𝗇', '𝖩𝗎𝗅', '𝖠𝗎𝗀', '𝖲𝖾𝗉', '𝖮𝖼𝗍', '𝖭𝗈𝗏', '𝖣𝖾𝖼'][ist.getUTCMonth()];
    const year = ist.getUTCFullYear();
    let hours = ist.getUTCHours();
    const ampm = hours >= 12 ? '𝖯𝗆' : '𝖠𝗆';
    hours = hours % 12 || 12;
    const mins = String(ist.getUTCMinutes()).padStart(2, '0');
    const secs = String(ist.getUTCSeconds()).padStart(2, '0');
    return `${day} ${month} ${year}, ${hours}:${mins}:${secs} ${ampm} Isᴛ`;
}

async function trackCommand(cmd) {
    await Store.trackCommand(cmd);
}

function isOwner(userId, ownerId) {
    return ownerId && String(userId) === String(ownerId);
}

function isGroupChat(chatType) {
    return ['group', 'supergroup'].includes(chatType);
}

async function isGroupAdmin(botApi, chatId, userId) {
    try {
        const res = await botApi.getChatMember(chatId, userId);
        return ['creator', 'administrator'].includes(res.result?.status);
    } catch {
        return false;
    }
}

function getReactionsForChat(chatId, globalReactions) {
    const custom = Store.getReaction(chatId);
    if (custom) {
        return splitEmojis(custom);
    }
    return globalReactions;
}

function checkRateLimit(chatId) {
    const now = Date.now();
    const entry = rateLimitMap[chatId];

    if (!entry || now > entry.resetAt) {
        rateLimitMap[chatId] = { count: 1, resetAt: now + RATE_LIMIT_WINDOW };
        return true;
    }

    if (entry.count >= RATE_LIMIT_MAX) return false;
    entry.count++;
    return true;
}

function logReaction(chatId, emoji) {
    reactionLog.push({ chatId, emoji, timestamp: Date.now() });
    if (reactionLog.length > LOG_MAX) reactionLog.shift();
}

function getTopChats(limit = 5) {
    const counts = {};
    for (const entry of reactionLog) {
        counts[entry.chatId] = (counts[entry.chatId] || 0) + 1;
    }
    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
}

function withAd(msg) {
    return msg + getAdFooter();
}

async function cleanupMessages(botApi, chatId, userMessageId) {
    // Delete previous bot response
    if (lastBotMessage[chatId]) {
        try { await botApi.deleteMessage(chatId, lastBotMessage[chatId]); } catch {}
        delete lastBotMessage[chatId];
    }
    // Delete user's command message
    try { await botApi.deleteMessage(chatId, userMessageId); } catch {}
}

function trackBotMessage(chatId, sent) {
    const msgId = sent?.result?.message_id;
    if (msgId) lastBotMessage[chatId] = msgId;
}

// ══════════════════════════════════════════════════════════════
// INLINE KEYBOARDS
// ══════════════════════════════════════════════════════════════

const startTime = Date.now();

function getStatsMessage() {
    const storeStats = Store.getStats();
    const uptime = formatUptime(Date.now() - startTime);
    const cmdLines = Object.entries(storeStats.commandUsage)
        .map(([cmd, count]) => `<code>/${cmd}</code> — ${count}`)
        .join('\n') || '𝖭𝗈 𝖼𝗈𝗆𝗆𝖺𝗇𝖽𝗌 𝗁𝖺𝗏𝖾 𝖻𝖾𝖾𝗇 𝗎𝗌𝖾𝖽 𝗒𝖾𝗍. 𝖨𝗆𝗉𝗋𝖾𝗌𝗌𝗂𝗏𝖾 𝗋𝖾𝗌𝗍𝗋𝖺𝗂𝗇𝗍 😶';

    let topChatsText = '';
    const top = getTopChats(5);
    if (top.length) {
        topChatsText = '\n\n🏆 𝗧𝗼𝗽 𝗖𝗵𝗮𝘁𝘀 <i>(𝖫𝖺𝗌𝗍 50 𝖱𝖾𝖺𝖼𝗍𝗂𝗈𝗇𝗌)</i>\n' +
            top.map(([id, count], i) => {
                const name = chatNames[id] || `Chat ${id}`;
                return `${i + 1}. ${name} — ${count}`;
            }).join('\n');
    }

    return `${statsHeader}📨 𝗠𝗲𝘀𝘀𝗮𝗴𝗲𝘀 𝗣𝗿𝗼𝗰𝗲𝘀𝘀𝗲𝗱: ${storeStats.messagesProcessed.toLocaleString()}
💫 𝗥𝗲𝗮𝗰𝘁𝗶𝗼𝗻𝘀 𝗦𝗲𝗻𝘁: ${storeStats.reactionsSent.toLocaleString()}
💬 𝗨𝗻𝗶𝗾𝘂𝗲 𝗖𝗵𝗮𝘁𝘀: ${uniqueChats.size.toLocaleString()} <i>(𝖲𝖾𝗌𝗌𝗂𝗈𝗇)</i> · ${Store.getChatCount().toLocaleString()} <i>(𝖳𝗈𝗍𝖺𝗅)</i>
💾 𝗦𝘁𝗼𝗿𝗮𝗴𝗲: ${Store.getStorageType()}
⏸️ 𝗣𝗮𝘂𝘀𝗲𝗱 𝗖𝗵𝗮𝘁𝘀: ${Store.getPausedCount().toLocaleString()}
🚫 𝗥𝗲𝘀𝘁𝗿𝗶𝗰𝘁𝗲𝗱 𝗖𝗵𝗮𝘁𝘀: ${Store.getRestrictedCount().toLocaleString()}
🎲 𝗥𝗮𝗻𝗱𝗼𝗺 𝗟𝗲𝘃𝗲𝗹 𝗢𝘃𝗲𝗿𝗿𝗶𝗱𝗲𝘀: ${Object.keys(perChatRandomLevel).length.toLocaleString()}
👋 𝗪𝗲𝗹𝗰𝗼𝗺𝗲 𝗘𝗻𝗮𝗯𝗹𝗲𝗱: ${Store.getWelcomeCount().toLocaleString()}
🚪 𝗚𝗼𝗼𝗱𝗯𝘆𝗲 𝗘𝗻𝗮𝗯𝗹𝗲𝗱: ${Store.getGoodbyeCount().toLocaleString()}
⏱️ 𝗨𝗽𝘁𝗶𝗺𝗲: ${uptime}
🕐 𝗦𝘁𝗮𝗿𝘁𝗲𝗱: ${formatIST(startTime)}

📋 𝗖𝗼𝗺𝗺𝗮𝗻𝗱 𝗨𝘀𝗮𝗴𝗲:
${cmdLines}${topChatsText}

<i>𝖦𝗅𝗈𝖻𝖺𝗅 𝗌𝗍𝖺𝗍𝗌. 𝖤𝗏𝖾𝗋𝗒𝗍𝗁𝗂𝗇𝗀 𝗂𝗌 𝗋𝗎𝗇𝗇𝗂𝗇𝗀 𝗌𝗆𝗈𝗈𝗍𝗁𝗅𝗒 ✨</i>`;
}

// ══════════════════════════════════════════════════════════════
// INLINE KEYBOARDS
// ══════════════════════════════════════════════════════════════


function getStartKeyboard(botUsername, userId, ownerId) {
    const keyboard = [
        [
            { text: '⇆ 𝖠𝖽𝖽 𝖬𝖾 𝖳𝗈 𝖸𝗈𝗎𝗋 𝖦𝗋𝗈𝗎𝗉 ⇆', url: `https://telegram.me/${botUsername}?startgroup=botstart`, style: 'success' },
        ],
        [
            { text: 'ℹ️ 𝖠𝖻𝗈𝗎𝗍', callback_data: 'cb_about', style: 'primary' },
            { text: '📚 𝖧𝖾𝗅𝗉', callback_data: 'cb_help', style: 'primary' },
        ],
    ];

    // Show admin panel button only to the owner
    if (ownerId && userId && String(userId) === String(ownerId)) {
        keyboard.push([{ text: '𝘤𝖯𝖺𝗇𝖾𝗅', callback_data: '!admin', style: 'success' }]);
    }

    keyboard.push([{ text: '⇆ 𝖠𝖽𝖽 𝖬𝖾 𝖳𝗈 𝖸𝗈𝗎𝗋 𝖢𝗁𝖺𝗇𝗇𝖾𝗅 ⇆', url: `https://telegram.me/${botUsername}?startchannel=botstart`, style: 'success' }]);
    return keyboard;
}

function getAboutKeyboard() {
    return [
        [
            { text: '🌐 𝖶𝖾𝖻𝗌𝗂𝗍𝖾 ✨', url: 'https://alyareactionbot.vercel.app', style: 'success' }
        ],
        [
            { text: '☕ 𝖣𝗈𝗇𝖺𝗍𝖾', callback_data: 'cb_donate', style: 'primary' },
            { text: '📊 𝖲𝗍𝖺𝗍𝗌', callback_data: 'cb_stats', style: 'primary' },
        ],
        [
            { text: '↩️ 𝖡𝖺𝖼𝗄', callback_data: 'cb_menu', style: 'primary' }
        ]
    ];
}

function getTbKeyboard() {
    return [
        [
            { text: '↩️ 𝖡𝖺𝖼𝗄', callback_data: 'cb_about', style: 'primary' },
            { text: '❌ 𝖢𝗅𝗈𝗌𝖾', callback_data: 'cb_close', style: 'danger' }
        ]
    ];
}

function getHelpKeyboard(userId, ownerId) {
    const keyboard = [
        [
            { text: '✨ 𝖱𝖾𝖺𝖼𝗍𝗂𝗈𝗇𝗌 💫', callback_data: 'cb_reactions', style: 'success' },
        ],
        [
            { text: '📢 𝖴𝗉𝖽𝖺𝗍𝖾𝗌', url: 'https://t.me/reactionbotupdate', style: 'primary' },
            { text: '💬 𝖲𝗎𝗉𝗉𝗈𝗋𝗍', url: 'https://t.me/reactionbotupdate', style: 'primary' },
        ],
    ];

    // Show admin panel button only to the owner
    if (ownerId && userId && String(userId) === String(ownerId)) {
        keyboard.push([{ text: '𝘤𝖯𝖺𝗇𝖾𝗅', callback_data: '!admin', style: 'success' }]);
    }

    keyboard.push([
        { text: '↩️ 𝖡𝖺𝖼𝗄', callback_data: 'cb_menu', style: 'primary' },
        { text: '❌ 𝖢𝗅𝗈𝗌𝖾', callback_data: 'cb_close', style: 'danger' }
    ]);
    return keyboard;
}

function getreactKeyboard() {
    return [
        [
            { text: '↩️ 𝖡𝖺𝖼𝗄', callback_data: 'cb_help', style: 'primary' },
            { text: '❌ 𝖢𝗅𝗈𝗌𝖾', callback_data: 'cb_close', style: 'danger' }
        ]
    ];
}

function getCloseKeyboard() {
    return [
        [
            { text: '✗ 𝖢𝗅𝗈𝗌𝖾 ✗', callback_data: 'cb_close', style: 'danger' }
        ]
    ];
}

// ══════════════════════════════════════════════════════════════
// FORCE SUBSCRIBE
// ══════════════════════════════════════════════════════════════

async function checkForceSubscribe(botApi, userId, channels) {
    if (!channels || channels.length === 0) return { subscribed: true, notJoined: [] };

    const notJoined = [];

    for (const channel of channels) {
        try {
            const member = await botApi.getChatMember(channel, userId);
            const status = member?.result?.status;
            if (!status || ['left', 'kicked', 'banned'].includes(status)) {
                notJoined.push(channel);
            }
        } catch {
            // Channel might be invalid or bot not admin — skip silently
            log.warn(`[ForceSub] Cannot check membership for ${channel}`);
        }
    }

    return { subscribed: notJoined.length === 0, notJoined };
}

function getForceSubMessage(notJoined) {
    const buttons = notJoined.map((ch, i) => {
        const clean = ch.replace(/^@/, '');
        const url = clean.match(/^-?\d+$/)
            ? `https://telegram.me/c/${clean.replace(/^-100/, '')}`
            : `https://telegram.me/${clean}`;
        return [{ text: `📢 𝖩𝗈𝗂𝗇 𝖢𝗁𝖺𝗇𝗇𝖾𝗅 ✨`, url, style: 'success' }];
    });

    buttons.push([{ text: '🔄 𝖳𝗋𝗒 𝖠𝗀𝖺𝗂𝗇 ✨', callback_data: 'cb_forcecheck', style: 'primary' }]);

    return {
        text: `🚀 𝖠𝖼𝖼𝖾𝗌𝗌 𝖱𝖾𝗊𝗎𝗂𝗋𝖾𝖽\n\n📢 𝖯𝗅𝖾𝖺𝗌𝖾 𝗃𝗈𝗂𝗇 𝗍𝗁𝖾 𝗋𝖾𝗊𝗎𝗂𝗋𝖾𝖽 𝖼𝗁𝖺𝗇𝗇𝖾𝗅(𝗌) 𝖿𝗂𝗋𝗌𝗍.\n\n✨ 𝖮𝗇𝖼𝖾 𝗒𝗈𝗎'𝗏𝖾 𝗃𝗈𝗂𝗇𝖾𝖽, 𝗍𝖺𝗉 "𝖳𝗋𝗒 𝖠𝗀𝖺𝗂𝗇" 𝗍𝗈 𝖼𝗈𝗇𝗍𝗂𝗇𝗎𝖾.`,
        keyboard: buttons,
    };
}


// ══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════


export async function onUpdate(data, botApi, Reactions, RestrictedChats, botUsername, RandomLevel, ownerId, webhookSecret, botPhoto, forceSubChannels = []) {

    // Load persistent chat store (idempotent — only loads once)
    await Store.load();

    // Guard against NaN RandomLevel from invalid env var
    if (isNaN(RandomLevel) || RandomLevel < 0 || RandomLevel > 10) {
        RandomLevel = 0;
    }

    // ---- FEATURE: Callback Query Handler ----

    // ─── Callback Query ───
    if (data.callback_query) {
        const cq = data.callback_query;
        const chatId = cq.message?.chat?.id;
        const messageId = cq.message?.message_id;

        try {
            // Link preview options — show BOT_PHOTO as large preview above text
            const linkPreview = botPhoto ? {
                url: botPhoto,
                prefer_large_media: true,
                show_above_text: true
            } : null;

            const editMsg = async (text, keyboard) => {
                await botApi.editMessageText(chatId, messageId, text, keyboard, linkPreview);
            };

            // Retrieve owner ID dynamically for admin panel visibility
            const callbackUserId = cq.from?.id;

            switch (cq.data) {
                case 'cb_help':
                    await editMsg(withAd(helpMessage), getHelpKeyboard(callbackUserId, ownerId));
                    break;
                case 'cb_about':
                    await editMsg(withAd(aboutMessage), getAboutKeyboard());
                    break;
                case 'cb_stats':
                    await editMsg(withAd(getStatsMessage()), getTbKeyboard());
                    break;
                case 'cb_donate':
                    await editMsg(withAd(donateMessage), getTbKeyboard());
                    break;
                case 'cb_reactions': {
                    const reactions = getReactionsForChat(chatId, Reactions).join(' ');
                    const isCustom = Store.getReaction(chatId) ? `\n\n<i>✨ 𝖢𝗎𝗌𝗍𝗈𝗆 𝗋𝖾𝖺𝖼𝗍𝗂𝗈𝗇 𝗌𝖾𝗍 𝗂𝗌 𝖺𝖼𝗍𝗂𝗏𝖾 𝖿𝗈𝗋 𝗍𝗁𝗂𝗌 𝖼𝗁𝖺𝗍.</i>` : `\n\n<i>📌 𝖴𝗌𝗂𝗇𝗀 𝗆𝗒 𝖽𝖾𝖿𝖺𝗎𝗅𝗍 𝗋𝖾𝖺𝖼𝗍𝗂𝗈𝗇 𝗌𝖾𝗍.</i>`;
                    await editMsg(withAd(`🚀 𝗘𝗻𝗮𝗯𝗹𝗲𝗱 𝗥𝗲𝗮𝗰𝘁𝗶𝗼𝗻𝘀:\n\n${reactions}${isCustom}`), getreactKeyboard());
                    break;
                }
                case '!admin':
                    if (!isOwner(callbackUserId, ownerId)) {
                        await botApi.answerCallbackQuery(cq.id, '𝖳𝗁𝗂𝗌 𝖼𝗈𝗆𝗆𝖺𝗇𝖽 𝗂𝗌 𝖿𝗈𝗋 𝗍𝗁𝖾 𝗈𝗐𝗇𝖾𝗋 𝗈𝗇𝗅𝗒. 𝖭𝗂𝖼𝖾 𝗍𝗋𝗒 😶', true);
                        return;
                    }
                    await editMsg(withAd(adminPanelMessage), getCloseKeyboard());
                    break;
                case 'cb_menu': {
                    const name = cq.message?.chat?.type === 'private'
                        ? (cq.from?.first_name || cq.message?.chat?.title)
                        : cq.message?.chat?.title;
                    const caption = withAd(startMessage.replace('UserName', name));
                    const keyboard = getStartKeyboard(botUsername, callbackUserId, ownerId);
                    await editMsg(caption, keyboard);
                    break;
                }
                case 'cb_forcecheck': {
                    // Re-check force subscribe status
                    if (forceSubChannels.length > 0) {
                        const { subscribed, notJoined } = await checkForceSubscribe(botApi, callbackUserId, forceSubChannels);
                        if (subscribed) {
                            await botApi.answerCallbackQuery(cq.id, '✅ 𝖠𝗅𝗅 𝖲𝖾𝗍! 𝖸𝗈𝗎 𝖼𝖺𝗇 𝗇𝗈𝗐 𝗎𝗌𝖾 𝗍𝗁𝖾 𝖻𝗈𝗍. 🚀');
                            const name = cq.from?.first_name || 'User';
                            const caption = withAd(startMessage.replace('UserName', name));
                            const keyboard = getStartKeyboard(botUsername, callbackUserId, ownerId);
                            await editMsg(caption, keyboard);
                        } else {
                            await botApi.answerCallbackQuery(cq.id, '⚠️ 𝖯𝗅𝖾𝖺𝗌𝖾 𝗃𝗈𝗂𝗇 𝖺𝗅𝗅 𝗋𝖾𝗊𝗎𝗂𝗋𝖾𝖽 𝖼𝗁𝖺𝗇𝗇𝖾𝗅𝗌 𝖿𝗂𝗋𝗌𝗍.', true);
                        }
                    } else {
                        await botApi.answerCallbackQuery(cq.id, 'ℹ️ 𝖥𝗈𝗋𝖼𝖾 𝖲𝗎𝖻𝗌𝖼𝗋𝗂𝖻𝖾 𝗂𝗌 𝖼𝗎𝗋𝗋𝖾𝗇𝗍𝗅𝗒 𝖽𝗂𝗌𝖺𝖻𝗅𝖾𝖽.');
                    }
                    break;
                }
                case 'cb_close':
                    await botApi.deleteMessage(chatId, messageId);
                    break;
                default: {
                    await botApi.answerCallbackQuery(cq.id, '𝖨 𝖽𝗂𝖽 𝗇𝗈𝗍 𝗎𝗇𝖽𝖾𝗋𝗌𝗍𝖺𝗇𝖽 𝗐𝗁𝖺𝗍 𝗃𝗎𝗌𝗍 𝗁𝖺𝗉𝗉𝖾𝗇𝖾𝖽 😶', true);
                    return;
                }
            }
            await botApi.answerCallbackQuery(cq.id);
        } catch (error) {
            log.error('[Callback]', error.message);
            try { await botApi.answerCallbackQuery(cq.id, '𝖠𝗇 𝗎𝗇𝖾𝗑𝗉𝖾𝖼𝗍𝖾𝖽 𝖾𝗋𝗋𝗈𝗋 𝗈𝖼𝖼𝗎𝗋𝗋𝖾𝖽 😶', true); } catch {}
        }
        return;
    }

    // ─── Messages ───
    if (data.message || data.channel_post) {
        const content = data.message || data.channel_post;
        const chatId = content.chat.id;
        const message_id = content.message_id;
        const text = content.text;
        const chatType = content.chat.type;
        const userId = content.from?.id;

        // Cache chat name
        chatNames[chatId] = content.chat.title || content.chat.first_name || String(chatId);

        // Persist chat to disk
        await Store.updateChat(chatId, chatNames[chatId], chatType);

        // Track stats
        await Store.trackMessage();
        uniqueChats.add(chatId);

        // ---- FEATURE: Command Router ----

        // Link preview options — show BOT_PHOTO as large preview above text
        const linkPreview = botPhoto ? {
            url: botPhoto,
            prefer_large_media: true,
            show_above_text: true
        } : null;

    // ─── Commands (only from users, not channel posts) ───
        if (data.message && text) {
            const cmd = text.split(' ')[0].replace(/@\S+/, '');
            const args = text.split(' ').slice(1).join(' ');

            // ─── Force Subscribe Check (private chats only, skip owner) ───
            if (chatType === 'private' && forceSubChannels.length > 0 && String(userId) !== String(ownerId)) {
                const { subscribed, notJoined } = await checkForceSubscribe(botApi, userId, forceSubChannels);
                if (!subscribed) {
                    const fsMsg = getForceSubMessage(notJoined);
                    await botApi.sendMessage(chatId, fsMsg.text, fsMsg.keyboard);
                    return;
                }
            }

            // /start
            if (cmd === '/start') {
                trackCommand('start');
                const displayName = chatType === 'private'
                    ? (content.from?.first_name || content.chat.title)
                    : content.chat.title;
                const caption = withAd(startMessage.replace('UserName', displayName));
                const keyboard = getStartKeyboard(botUsername, userId, ownerId);
                await cleanupMessages(botApi, chatId, message_id);
                const sent = await botApi.sendMessage(chatId, caption, keyboard, linkPreview);
                trackBotMessage(chatId, sent);
                return;
            }

            // /help
            if (cmd === '/help') {
                trackCommand('help');
                await cleanupMessages(botApi, chatId, message_id);
                const sent = await botApi.sendMessage(chatId, withAd(helpMessage), getCloseKeyboard(), linkPreview);
                trackBotMessage(chatId, sent);
                return;
            }

            // /about
            if (cmd === '/about') {
                trackCommand('about');
                const caption = withAd(aboutMessage);
                await cleanupMessages(botApi, chatId, message_id);
                const sent = await botApi.sendMessage(chatId, caption, getCloseKeyboard(), linkPreview);
                trackBotMessage(chatId, sent);
                return;
            }

            // /ping
            if (cmd === '/ping') {
                trackCommand('ping');
                const start = Date.now();
                await cleanupMessages(botApi, chatId, message_id);
                try {
                    const sent = await botApi.sendMessage(chatId, '𝖢𝗁𝖾𝖼𝗄𝗂𝗇𝗀 𝗋𝖾𝗌𝗉𝗈𝗇𝗌𝖾 𝗌𝗉𝖾𝖾𝖽 ⚡', getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    const latency = Date.now() - start;
                    const msgId = sent?.result?.message_id;
                    const pingText = withAd(pingMessage(latency) + `\n🕐 ${formatIST(Date.now())}`);
                    if (msgId) {
                        await botApi.editMessageText(chatId, msgId, pingText, getCloseKeyboard(), linkPreview);
                    } else {
                        const sent2 = await botApi.sendMessage(chatId, pingText, getCloseKeyboard(), linkPreview);
                        trackBotMessage(chatId, sent2);
                    }
                } catch {
                    const latency = Date.now() - start;
                    const pingText = withAd(pingMessage(latency) + `\n\n🕐 ${formatIST(Date.now())}`);
                    const sent2 = await botApi.sendMessage(chatId, pingText, getCloseKeyboard(), linkPreview);
                    trackBotMessage(chatId, sent2);
                }
                return;
            }

            // /stats
            if (cmd === '/stats') {
                trackCommand('stats');
                const caption = withAd(getStatsMessage());
                await cleanupMessages(botApi, chatId, message_id);
                const sent = await botApi.sendMessage(chatId, caption, getCloseKeyboard(), linkPreview);
                trackBotMessage(chatId, sent);
                return;
            }

            // /reactions
            if (cmd === '/reactions') {
                trackCommand('reactions');
                const reactions = getReactionsForChat(chatId, Reactions).join(' ');
                const isCustom = Store.getReaction(chatId) ? `\n\n<i>✨ 𝖢𝗎𝗌𝗍𝗈𝗆 𝗋𝖾𝖺𝖼𝗍𝗂𝗈𝗇 𝗌𝖾𝗍 𝗂𝗌 𝖺𝖼𝗍𝗂𝗏𝖾 𝖿𝗈𝗋 𝗍𝗁𝗂𝗌 𝖼𝗁𝖺𝗍.</i>` : `\n\n<i>📌 𝖴𝗌𝗂𝗇𝗀 𝗆𝗒 𝖽𝖾𝖿𝖺𝗎𝗅𝗍 𝗋𝖾𝖺𝖼𝗍𝗂𝗈𝗇 𝗌𝖾𝗍.</i>`;
                const caption = withAd(`🚀 𝗘𝗻𝗮𝗯𝗹𝗲𝗱 𝗥𝗲𝗮𝗰𝘁𝗶𝗼𝗻𝘀:\n\n${reactions}${isCustom}`);
                await cleanupMessages(botApi, chatId, message_id);
                const sent = await botApi.sendMessage(chatId, caption, getCloseKeyboard(), linkPreview);
                trackBotMessage(chatId, sent);
                return;
            }

            // /setreactions (group admins only)
            if (cmd === '/setreactions') {
                trackCommand('setreactions');
                if (!isGroupChat(chatType)) {
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, groupOnlyMessage, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                if (!await isGroupAdmin(botApi, chatId, userId)) {
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, onlyAdminMessage, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                await cleanupMessages(botApi, chatId, message_id);
                if (!args || args.trim().length === 0) {
                    await Store.deleteReaction(chatId);
                    const sent = await botApi.sendMessage(chatId, reactionsReset, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                const emojis = splitEmojis(args.trim());
                if (emojis.length === 0) {
                    const sent = await botApi.sendMessage(chatId, reactionsInvalid, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                await Store.setReaction(chatId, emojis.join(''));
                const sent = await botApi.sendMessage(chatId,
                    withAd(`${reactionsUpdated}✨ 𝗡𝗲𝘄 𝗥𝗲𝗮𝗰𝘁𝗶𝗼𝗻𝘀: ${emojis.join(' ')}`),
                    getBackKeyboard(), linkPreview
                );
                trackBotMessage(chatId, sent);
                return;
            }

            // /pause (group admins only)
            if (cmd === '/pause') {
                trackCommand('pause');
                await cleanupMessages(botApi, chatId, message_id);
                if (!isGroupChat(chatType)) {
                    const sent = await botApi.sendMessage(chatId, groupOnlyMessage, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                if (!await isGroupAdmin(botApi, chatId, userId)) {
                    const sent = await botApi.sendMessage(chatId, onlyAdminMessage, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                await Store.pauseChat(chatId);
                const sent = await botApi.sendMessage(chatId, withAd(pausedMessage), getCloseKeyboard(), linkPreview);
                trackBotMessage(chatId, sent);
                return;
            }

            // /resume (group admins only)
            if (cmd === '/resume') {
                trackCommand('resume');
                await cleanupMessages(botApi, chatId, message_id);
                if (!isGroupChat(chatType)) {
                    const sent = await botApi.sendMessage(chatId, groupOnlyMessage, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                if (!await isGroupAdmin(botApi, chatId, userId)) {
                    const sent = await botApi.sendMessage(chatId, onlyAdminMessage, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                if (!Store.isPaused(chatId)) {
                    const sent = await botApi.sendMessage(chatId, withAd(notPausedMessage), getCloseKeyboard(), linkPreview);
                    trackBotMessage(chatId, sent);
                    return;
                }
                await Store.resumeChat(chatId);
                const sent = await botApi.sendMessage(chatId, withAd(resumedMessage), getCloseKeyboard(), linkPreview);
                trackBotMessage(chatId, sent);
                return;
            }

            // /randomlevel <0-10> (group admins only for override; shows info in DMs)
            if (cmd === '/randomlevel') {
                trackCommand('randomlevel');
                await cleanupMessages(botApi, chatId, message_id);
                try {
                    const trimmedArgs = args?.trim();
                    const isGroup = isGroupChat(chatType);

                    // In private chats, show global default info (no override possible)
                    if (!isGroup) {
                        const globalLevel = RandomLevel;
                        const globalChance = (10 - globalLevel) * 10;
                        const sent = await botApi.sendMessage(chatId,
                            withAd(`🎲 𝗥𝗮𝗻𝗱𝗼𝗺 𝗟𝗲𝘃𝗲𝗹 — 𝗚𝗹𝗼𝗯𝗮𝗹 𝗗𝗲𝗳𝗮𝘂𝗹𝘁\n\n` +
                            `📊 𝗖𝘂𝗿𝗿𝗲𝗻𝘁: <code>${globalLevel}</code> — 𝖱𝖾𝖺𝖼𝗍𝗌 ~${globalChance}% 𝗈𝖿 𝗍𝗁𝖾 𝗍𝗂𝗆𝖾\n\n` +
                            `💡 <code>0</code> = 𝖤𝗏𝖾𝗋𝗒 𝖬𝖾𝗌𝗌𝖺𝗀𝖾 | <code>10</code> = 𝖭𝖾𝗏𝖾𝗋\n\n` +
                            `⚠️ 𝖳𝗈 𝗈𝗏𝖾𝗋𝗋𝗂𝖽𝖾, 𝗎𝗌𝖾 <code>/randomlevel &lt;0-10&gt;</code> 𝗂𝗇 𝖺 𝗀𝗋𝗈𝗎𝗉.\n` +
                            `📌 𝖠𝖽𝗆𝗂𝗇𝗌 𝗈𝗇𝗅𝗒.`),
                            getCloseKeyboard(), linkPreview
                        );
                        trackBotMessage(chatId, sent);
                        return;
                    }

                    // Group: require admin permission
                    if (!await isGroupAdmin(botApi, chatId, userId)) {
                        const sent = await botApi.sendMessage(chatId, onlyAdminMessage, getCloseKeyboard());
                        trackBotMessage(chatId, sent);
                        return;
                    }

                    // No args → show current level for this chat
                    if (!trimmedArgs) {
                        const current = perChatRandomLevel[chatId] !== undefined
                            ? perChatRandomLevel[chatId]
                            : RandomLevel;
                        const source = perChatRandomLevel[chatId] !== undefined ? '𝖢𝗎𝗌𝗍𝗈𝗆' : '𝖦𝗅𝗈𝖻𝖺𝗅';
                        const currentChance = (10 - current) * 10;
                        const sent = await botApi.sendMessage(chatId,
                            withAd(`🎲 𝗥𝗮𝗻𝗱𝗼𝗺 𝗟𝗲𝘃𝗲𝗹 𝗙𝗼𝗿 𝗧𝗵𝗶𝘀 𝗖𝗵𝗮𝘁:\n\n` +
                            `📊 𝗖𝘂𝗿𝗿𝗲𝗻𝘁: <code>${current}</code> (${source}) — 𝖱𝖾𝖺𝖼𝗍𝗌 ~${currentChance}%\n` +
                            `📌 𝗚𝗹𝗼𝗯𝗮𝗹 𝗗𝗲𝗳𝗮𝘂𝗹𝘁: <code>${RandomLevel}</code>\n\n` +
                            `💡 𝖴𝗌𝖾 <code>/randomlevel &lt;0-10&gt;</code> 𝗍𝗈 𝖼𝗁𝖺𝗇𝗀𝖾 𝗍𝗁𝖾 𝗅𝖾𝗏𝖾𝗅.`),
                            getCloseKeyboard(), linkPreview
                        );
                        trackBotMessage(chatId, sent);
                        return;
                    }

                    // Validate the level value
                    const level = parseInt(trimmedArgs, 10);
                    if (isNaN(level) || level < 0 || level > 10) {
                        const sent = await botApi.sendMessage(chatId,
                            `📵 𝗜𝗻𝘃𝗮𝗹𝗶𝗱 𝗥𝗮𝗻𝗱𝗼𝗺 𝗟𝗲𝘃𝗲𝗹!\n\n` +
                            `📌 𝗨𝘀𝗮𝗴𝗲: <code>/randomlevel &lt;0-10&gt;</code>\n` +
                            `💡 <code>0</code> = 𝖤𝗏𝖾𝗋𝗒 𝖬𝖾𝗌𝗌𝖺𝗀𝖾 | <code>10</code> = 𝖭𝖾𝗏𝖾𝗋\n\n` +
                            `<i>𝖱𝖺𝗇𝖽𝗈𝗆 𝗅𝖾𝗏𝖾𝗅 𝗆𝗎𝗌𝗍 𝖻𝖾 𝖻𝖾𝗍𝗐𝖾𝖾𝗇 <code>0</code> 𝖺𝗇𝖽 <code>10</code>.</i>`,
                            getCloseKeyboard()
                        );
                        trackBotMessage(chatId, sent);
                        return;
                    }

                    // Set per-chat override
                    perChatRandomLevel[chatId] = level;
                    const chance = (10 - level) * 10;
                    const sent = await botApi.sendMessage(chatId,
                        withAd(`🎲 𝗥𝗮𝗻𝗱𝗼𝗺 𝗟𝗲𝘃𝗲𝗹 𝗦𝗲𝘁!\n\n` +
                        `🎯 𝗟𝗲𝘃𝗲𝗹: <code>${level}</code> — 𝖱𝖾𝖺𝖼𝗍𝗌 ~${chance}% 𝗈𝖿 𝗍𝗁𝖾 𝗍𝗂𝗆𝖾\n\n` +
                        `💡 <code>0</code> = 𝖤𝗏𝖾𝗋𝗒 𝖬𝖾𝗌𝗌𝖺𝗀𝖾 | <code>10</code> = 𝖭𝖾𝗏𝖾𝗋\n` +
                        `🔄 <i>𝖱𝖾𝗌𝖾𝗍𝗌 𝗈𝗇 𝗋𝖾𝗌𝗍𝖺𝗋𝗍.</i>`),
                        getCloseKeyboard(), linkPreview
                    );
                    trackBotMessage(chatId, sent);
                } catch (error) {
                    log.error('[/randomlevel]', error.message);
                    try {
                        const sent = await botApi.sendMessage(chatId, `📵 𝗙𝗮𝗶𝗹𝗲𝗱 𝗧𝗼 𝗣𝗿𝗼𝗰𝗲𝘀𝘀!\n\n<i>𝖤𝗋𝗋𝗈𝗋: ${error.message}</i>`, getCloseKeyboard());
                        trackBotMessage(chatId, sent);
                    } catch {}
                }
                return;
            }

            // /donate
            if (cmd === '/donate') {
                trackCommand('donate');
                const caption = withAd(donateMessage);
                await cleanupMessages(botApi, chatId, message_id);
                const sent = await botApi.sendMessage(chatId, caption, getCloseKeyboard(), linkPreview);
                trackBotMessage(chatId, sent);
                return;
            }

            // /broadcast (owner only, with cooldown)
            if (cmd === '/broadcast') {
                trackCommand('broadcast');
                if (!isOwner(userId, ownerId)) {
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, onlyOwnerMessage, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                if (!args || args.trim().length === 0) {
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, '📝 𝗨𝘀𝗮𝗴𝗲: <code>/broadcast &lt;message&gt;</code>', getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                const now = Date.now();
                if (now - lastBroadcastTime < BROADCAST_COOLDOWN) {
                    const remaining = Math.ceil((BROADCAST_COOLDOWN - (now - lastBroadcastTime)) / 1000);
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, `⏳ 𝗖𝗼𝗼𝗹𝗱𝗼𝘄𝗻 𝗔𝗰𝘁𝗶𝘃𝗲!\n\n<i>𝖯𝗅𝖾𝖺𝗌𝖾 𝗐𝖺𝗂𝗍 ${remaining}s 𝖻𝖾𝖿𝗈𝗋𝖾 𝗍𝗋𝗒𝗂𝗇𝗀 𝖺𝗀𝖺𝗂𝗇.`, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                lastBroadcastTime = now;
                await cleanupMessages(botApi, chatId, message_id);
                let sent = await botApi.sendMessage(chatId, broadcastStarted, getCloseKeyboard());
                trackBotMessage(chatId, sent);
                const allChats = new Set(uniqueChats);
                if (userId) allChats.add(userId);
                let success = 0, failed = 0;
                for (const cid of allChats) {
                    try {
                        await botApi.sendMessage(cid, `📢 𝗕𝗿𝗼𝗮𝗱𝗰𝗮𝘀𝘁:\n\n${args.trim()}`);
                        success++;
                    } catch {
                        failed++;
                    }
                }
                sent = await botApi.sendMessage(chatId, withAd(broadcastDone(success, failed)), getCloseKeyboard(), linkPreview);
                trackBotMessage(chatId, sent);
                return;
            }

            // /log (owner only)
            if (cmd === '/log') {
                trackCommand('log');
                if (!isOwner(userId, ownerId)) {
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, onlyOwnerMessage, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                if (reactionLog.length === 0) {
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, '📋 𝗥𝗲𝗮𝗰𝘁𝗶𝗼𝗻 𝗟𝗼𝗴 𝗜𝘀 𝗘𝗺𝗽𝘁𝘆!\n\n<i>𝖭𝗈 𝗋𝖾𝖺𝖼𝗍𝗂𝗈𝗇 𝖺𝖼𝗍𝗂𝗏𝗂𝗍𝗒 𝗁𝖺𝗌 𝖻𝖾𝖾𝗇 𝗋𝖾𝖼𝗈𝗋𝖽𝖾𝖽 𝗒𝖾𝗍.</i>', getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                const lines = reactionLog.slice(-10).reverse().map((e, i) => {
                    const time = formatIST(e.timestamp);
                    const name = chatNames[e.chatId] || e.chatId;
                    return `${i + 1}. ${e.emoji} → ${name} (${time})`;
                }).join('\n');
                await cleanupMessages(botApi, chatId, message_id);
                const sent = await botApi.sendMessage(chatId, withAd(`📋 𝗟𝗮𝘀𝘁 10 𝗥𝗲𝗮𝗰𝘁𝗶𝗼𝗻𝘀:\n\n${lines}`), getCloseKeyboard(), linkPreview);
                trackBotMessage(chatId, sent);
                return;
            }

            // /leave and /remove (owner only)
            if (cmd === '/leave' || cmd === '/remove') {
                trackCommand(cmd === '/leave' ? 'leave' : 'remove');
                if (!isOwner(userId, ownerId)) {
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, onlyOwnerMessage, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                if (!args || args.trim().length === 0) {
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, '📝 𝗨𝘀𝗮𝗴𝗲: <code>/leave &lt;chat_id&gt;</code>', getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                const targetChatId = args.trim();
                if (!/^-?\d+$/.test(targetChatId)) {
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, '📵 𝗜𝗻𝘃𝗮𝗹𝗶𝗱 𝗖𝗵𝗮𝘁 𝗜𝗗!\n\n<i>𝖢𝗁𝖺𝗍 𝖨𝖣 𝗆𝗎𝗌𝗍 𝖻𝖾 𝗇𝗎𝗆𝖾𝗋𝗂𝖼.</i>', getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                await cleanupMessages(botApi, chatId, message_id);
                try {
                    await botApi.leaveChat(targetChatId);
                    uniqueChats.delete(Number(targetChatId));
                    delete perChatRandomLevel[targetChatId];
                    await Store.removeChat(targetChatId);
                    const sent = await botApi.sendMessage(chatId, withAd(`✅ 𝗟𝗲𝗳𝘁 𝗖𝗵𝗮𝘁! <code>${targetChatId}</code>.`), getCloseKeyboard(), linkPreview);
                    trackBotMessage(chatId, sent);
                } catch (error) {
                    const sent = await botApi.sendMessage(chatId, `📵 𝗙𝗮𝗶𝗹𝗲𝗱 𝗧𝗼 𝗟𝗲𝗮𝘃𝗲 𝗖𝗵𝗮𝘁! <code>${targetChatId}</code>:\n${error.message}`, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                }
                return;
            }

            // /chats (owner only)
            if (cmd === '/chats') {
                trackCommand('chats');
                if (!isOwner(userId, ownerId)) {
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, onlyOwnerMessage, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                const allChats = Store.getAllChats();
                if (allChats.length === 0) {
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, '📭 𝗡𝗼 𝗔𝗰𝘁𝗶𝘃𝗲 𝗖𝗵𝗮𝘁𝘀 𝗬𝗲𝘁!', getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                const typeOrder = { supergroup: 0, group: 1, channel: 2, private: 3, unknown: 4 };
                allChats.sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9));

                const chatLines = allChats.map((c, i) => {
                    const typeEmoji = { group: '👥', supergroup: '👥', channel: '📢', private: '💬' }[c.type] || '❓';
                    const paused = Store.isPaused(c.id) ? ' ⏸️' : '';
                    const restricted = Store.isRestricted(c.id) || RestrictedChats.includes(c.id) ? ' 🚫' : '';
                    const msgs = c.messageCount ? ` — ${c.messageCount} msgs` : '';
                    return `${i + 1}. ${typeEmoji} ${c.title} (<code>${c.id}</code>)${paused}${restricted}${msgs}`;
                }).join('\n');

                const groups = allChats.filter(c => c.type === 'group' || c.type === 'supergroup').length;
                const channels = allChats.filter(c => c.type === 'channel').length;
                const privates = allChats.filter(c => c.type === 'private').length;

                const summary = `📊 ${groups} 𝖦𝗋𝗈𝗎𝗉𝗌 · ${channels} 𝖢𝗁𝖺𝗇𝗇𝖾𝗅𝗌 · ${privates} 𝖯𝗋𝗂𝗏𝖺𝗍𝖾`;
                await cleanupMessages(botApi, chatId, message_id);
                const sent = await botApi.sendMessage(chatId,
                    withAd(`💬 𝗔𝗹𝗹 𝗖𝗵𝗮𝘁𝘀 (${allChats.length}):\n\n${chatLines}\n\n${summary}\n\n⏸️ = 𝖯𝖺𝗎𝗌𝖾𝖽 | 🚫 = 𝖱𝖾𝗌𝗍𝗋𝗂𝖼𝗍𝖾𝖽 | 𝗆𝗌𝗀𝗌 = 𝖳𝗈𝗍𝖺𝗅 𝖬𝖾𝗌𝗌𝖺𝗀𝖾𝗌`),
                    getCloseKeyboard(), linkPreview
                );
                trackBotMessage(chatId, sent);
                return;
            }

            // /setwebhook <url> (owner only)
            if (cmd === '/setwebhook') {
                trackCommand('setwebhook');
                if (!isOwner(userId, ownerId)) {
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, onlyOwnerMessage, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                await cleanupMessages(botApi, chatId, message_id);
                if (!args || args.trim().length === 0) {
                    try {
                        const info = await botApi.getWebhookInfo();
                        const wh = info.result;
                        const status = wh.url ? `🔗 𝗨𝗿𝗹: ${wh.url}` : '📵 𝖭𝗈 𝖶𝖾𝖻𝗁𝗈𝗈𝗄 𝖲𝖾𝗍.';
                        const pending = wh.pending_update_count > 0 ? `\n⏳ 𝗣𝗲𝗻𝗱𝗶𝗻𝗴: ${wh.pending_update_count}` : '';
                        const error = wh.last_error_message ? `\n⚠️ 𝗘𝗿𝗿𝗼𝗿: ${wh.last_error_message}` : '';
                        const sent = await botApi.sendMessage(chatId, `📡 𝗪𝗲𝗯𝗵𝗼𝗼𝗸 𝗦𝘁𝗮𝘁𝘂𝘀:\n\n${status}${pending}${error}`, getCloseKeyboard(), linkPreview);
                        trackBotMessage(chatId, sent);
                    } catch (error) {
                        const sent = await botApi.sendMessage(chatId, `📵 𝗙𝗮𝗶𝗹𝗲𝗱 𝗧𝗼 𝗙𝗲𝘁𝗰𝗵 𝗪𝗲𝗯𝗵𝗼𝗼𝗸 𝗜𝗻𝗳𝗼:\n${error.message}`, getCloseKeyboard());
                        trackBotMessage(chatId, sent);
                    }
                    return;
                }
                const webhookUrl = args.trim();
                if (!webhookUrl.startsWith('https://')) {
                    const sent = await botApi.sendMessage(chatId, '📵 𝗜𝗻𝘃𝗮𝗹𝗶𝗱 𝗪𝗲𝗯𝗵𝗼𝗼𝗸 𝗨𝗿𝗹!\n\n<i>𝖶𝖾𝖻𝗁𝗈𝗈𝗄 𝖴𝗋𝗅 𝗆𝗎𝗌𝗍 𝗌𝗍𝖺𝗋𝗍 𝗐𝗂𝗍𝗁 <code>https://</code></i>', getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                try {
                    await botApi.setWebhook(webhookUrl, webhookSecret || '');
                    const sent = await botApi.sendMessage(chatId, withAd(`✅ 𝗪𝗲𝗯𝗵𝗼𝗼𝗸 𝗦𝗲𝘁 𝗦𝘂𝗰𝗰𝗲𝘀𝘀𝗳𝘂𝗹𝗹𝘆!

🔗 ${webhookUrl}`), getCloseKeyboard(), linkPreview);
                    trackBotMessage(chatId, sent);
                } catch (error) {
                    const sent = await botApi.sendMessage(chatId, `📵 𝗙𝗮𝗶𝗹𝗲𝗱 𝗧𝗼 𝗦𝗲𝘁 𝗪𝗲𝗯𝗵𝗼𝗼𝗸!\n${error.message}`, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                }
                return;
            }

            // /restrict <chatId> (owner only)
            if (cmd === '/restrict') {
                trackCommand('restrict');
                if (!isOwner(userId, ownerId)) {
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, onlyOwnerMessage, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                if (!args || args.trim().length === 0) {
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, '📝 𝗨𝘀𝗮𝗴𝗲: <code>/restrict &lt;chat_id&gt;</code>', getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                const restrictId = Number(args.trim());
                if (!restrictId) {
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, '📵 𝗜𝗻𝘃𝗮𝗹𝗶𝗱 𝗖𝗵𝗮𝘁 𝗜𝗗!', getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                await cleanupMessages(botApi, chatId, message_id);
                await Store.restrictChat(restrictId);
                const sent = await botApi.sendMessage(chatId, withAd(`🚫 𝗖𝗵𝗮𝘁 𝗥𝗲𝘀𝘁𝗿𝗶𝗰𝘁𝗲𝗱!\n\n<i>𝖨 𝗐𝗂𝗅𝗅 𝗇𝗈𝗍 𝗋𝖾𝖺𝖼𝗍 𝗂𝗇 𝖼𝗁𝖺𝗍 <code>${restrictId}</code>.</i>`), getCloseKeyboard(), linkPreview);
                trackBotMessage(chatId, sent);
                return;
            }

            // /unrestrict <chatId> (owner only)
            if (cmd === '/unrestrict') {
                trackCommand('unrestrict');
                if (!isOwner(userId, ownerId)) {
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, onlyOwnerMessage, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                if (!args || args.trim().length === 0) {
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, '📝 𝗨𝘀𝗮𝗴𝗲: <code>/unrestrict &lt;chat_id&gt;</code>', getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                const unrestrictId = Number(args.trim());
                if (!unrestrictId) {
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, '📵 𝗜𝗻𝘃𝗮𝗹𝗶𝗱 𝗖𝗵𝗮𝘁 𝗜𝗗!', getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                if (!Store.isRestricted(unrestrictId)) {
                    await cleanupMessages(botApi, chatId, message_id);
                    const sent = await botApi.sendMessage(chatId, 'ℹ️ 𝗖𝗵𝗮𝘁 𝗜𝘀 𝗡𝗼𝘁 𝗥𝗲𝘀𝘁𝗿𝗶𝗰𝘁𝗲𝗱!', getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                await cleanupMessages(botApi, chatId, message_id);
                await Store.unrestrictChat(unrestrictId);
                const sent = await botApi.sendMessage(chatId, withAd(`✅ 𝗖𝗵𝗮𝘁 𝗨𝗻𝗿𝗲𝘀𝘁𝗿𝗶𝗰𝘁𝗲𝗱!\n\n<i>𝖢𝗁𝖺𝗍 <code>${unrestrictId}</code> 𝗂𝗌 𝗇𝗈𝗐 𝖺𝖼𝗍𝗂𝗏𝖾 𝖺𝗀𝖺𝗂𝗇.</i>`), getCloseKeyboard(), linkPreview);
                trackBotMessage(chatId, sent);
                return;
            }

            // /welcome (group admins only — toggle welcome messages)
            if (cmd === '/welcome') {
                trackCommand('welcome');
                await cleanupMessages(botApi, chatId, message_id);
                if (!isGroupChat(chatType)) {
                    const sent = await botApi.sendMessage(chatId, groupOnlyMessage, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                if (!await isGroupAdmin(botApi, chatId, userId)) {
                    const sent = await botApi.sendMessage(chatId, onlyAdminMessage, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                const enabled = await Store.toggleWelcome(chatId);
                let sent;
                if (!enabled) {
                    sent = await botApi.sendMessage(chatId,
                        withAd(`🔕 𝗪𝗲𝗹𝗰𝗼𝗺𝗲 𝗠𝗲𝘀𝘀𝗮𝗴𝗲𝘀 𝗗𝗶𝘀𝗮𝗯𝗹𝗲𝗱!\n\n<i>𝖶𝖾𝗅𝖼𝗈𝗆𝖾 𝗆𝖾𝗌𝗌𝖺𝗀𝖾𝗌 𝖺𝗋𝖾 𝗇𝗈𝗐 𝗍𝗎𝗋𝗇𝖾𝖽 𝗈𝖿𝖿 😶‍🌫️</i>`),
                        getCloseKeyboard(), linkPreview
                    );
                } else {
                    sent = await botApi.sendMessage(chatId,
                        withAd(`🔔 𝗪𝗲𝗹𝗰𝗼𝗺𝗲 𝗠𝗲𝘀𝘀𝗮𝗴𝗲𝘀 𝗘𝗻𝗮𝗯𝗹𝗲𝗱!\n\n<i>𝖭𝖾𝗐 𝗆𝖾𝗆𝖻𝖾𝗋𝗌 𝗐𝗂𝗅𝗅 𝗋𝖾𝖼𝖾𝗂𝗏𝖾 𝗆𝗒 𝗀𝗋𝖾𝖾𝗍𝗂𝗇𝗀 😶‍🌫️</i>`),
                        getCloseKeyboard(), linkPreview
                    );
                }
                trackBotMessage(chatId, sent);
                return;
            }

            // /goodbye (group admins only — toggle leave messages)
            if (cmd === '/goodbye') {
                trackCommand('goodbye');
                await cleanupMessages(botApi, chatId, message_id);
                if (!isGroupChat(chatType)) {
                    const sent = await botApi.sendMessage(chatId, groupOnlyMessage, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                if (!await isGroupAdmin(botApi, chatId, userId)) {
                    const sent = await botApi.sendMessage(chatId, onlyAdminMessage, getCloseKeyboard());
                    trackBotMessage(chatId, sent);
                    return;
                }
                const enabled = await Store.toggleGoodbye(chatId);
                let sent;
                if (!enabled) {
                    sent = await botApi.sendMessage(chatId,
                        withAd(`🔕 𝗟𝗲𝗮𝘃𝗲 𝗠𝗲𝘀𝘀𝗮𝗴𝗲𝘀 𝗗𝗶𝘀𝗮𝗯𝗹𝗲𝗱!\n\n<i>𝖫𝖾𝖺𝗏𝖾 𝗆𝖾𝗌𝗌𝖺𝗀𝖾𝗌 𝖺𝗋𝖾 𝗇𝗈𝗐 𝗍𝗎𝗋𝗇𝖾𝖽 𝗈𝖿𝖿 😶‍🌫️</i>`),
                        getCloseKeyboard(), linkPreview
                    );
                } else {
                    sent = await botApi.sendMessage(chatId,
                        withAd(`🔔 𝗟𝗲𝗮𝘃𝗲 𝗠𝗲𝘀𝘀𝗮𝗴𝗲𝘀 𝗘𝗻𝗮𝗯𝗹𝗲𝗱!\n\n<i>𝖦𝗈𝗈𝖽𝖻𝗒𝖾 𝗆𝖾𝗌𝗌𝖺𝗀𝖾𝗌 𝗐𝗂𝗅𝗅 𝗇𝗈𝗐 𝖻𝖾 𝗌𝖾𝗇𝗍 😶‍🌫️</i>`),
                        getCloseKeyboard(), linkPreview
                    );
                }
                trackBotMessage(chatId, sent);
                return;
            }

        }

        // ---- FEATURE: Welcome & Leave Messages ----

        // ─── Welcome & Leave Messages ───
        if (data.message) {
            const msg = data.message;

            // New members joined
            if (msg.new_chat_members && msg.new_chat_members.length > 0 && Store.isWelcomeEnabled(chatId)) {
                const mentions = msg.new_chat_members
                    .map(m => `<b>${m.first_name || m.username || 'Traveler'}</b>`)
                    .join(', ');
                const chatTitle = content.chat.title || 'this group';
                const welcomeText =
                    `🎀 𝗪𝗲𝗹𝗰𝗼𝗺𝗲, ${mentions}! 🎋\n` +
                    `𝖸𝗈𝗎'𝗏𝖾 𝗌𝗍𝖾𝗉𝗉𝖾𝖽 𝗂𝗇𝗍𝗈 <b>${chatTitle}</b>.\n` +
                    `𝖨'𝗅𝗅 𝖻𝖾 𝗐𝖺𝗍𝖼𝗁𝗂𝗇𝗀... 𝖺𝗇𝖽 𝗋𝖾𝖺𝖼𝗍𝗂𝗇𝗀 ✨`

                try {
                    // Delete join notification
                    await botApi.deleteMessage(chatId, msg.message_id);
                } catch {}

                try {
                    await botApi.sendMessage(chatId, welcomeText, getCloseKeyboard(), linkPreview);
                } catch {}
            }

            // Member left
            if (msg.left_chat_member && Store.isGoodbyeEnabled(chatId)) {
                const user = msg.left_chat_member;
                const userName = user.first_name || user.username || 'Traveler';
                const chatTitle = content.chat.title || 'this group';
                const leaveText =
                    `👋 𝗚𝗼𝗼𝗱𝗯𝘆𝗲, <b>${userName}</b>.\n` +
                    `<b>${chatTitle}</b> 𝗐𝗂𝗅𝗅 𝖼𝗈𝗇𝗍𝗂𝗇𝗎𝖾 𝗈𝗇𝗐𝖺𝗋𝖽.\n\n` +
                    `😶‍🌫️ 𝖧𝗈𝗉𝖾 𝗍𝗈 𝗌𝖾𝖾 𝗒𝗈𝗎 𝖺𝗀𝖺𝗂𝗇.`;

                try {
                    // Delete leave notification
                    await botApi.deleteMessage(chatId, msg.message_id);
                } catch {}

                try {
                    await botApi.sendMessage(chatId, leaveText, getCloseKeyboard(), linkPreview);
                } catch {}
            }
        }

        // ---- FEATURE: Auto-Reaction Engine ----

        // ─── Auto-Reaction Logic ───
        if (RestrictedChats.includes(chatId)) return;
        if (Store.isRestricted(chatId)) return;
        if (Store.isPaused(chatId)) return;
        if (!checkRateLimit(chatId)) return;

        const chatReactions = getReactionsForChat(chatId, Reactions);
        const reaction = getRandomPositiveReaction(chatReactions);
        if (!reaction) return;

        const isGroup = isGroupChat(chatType);
        if (isGroup) {
            const chatRandomLevel = perChatRandomLevel[chatId] !== undefined
                ? perChatRandomLevel[chatId]
                : RandomLevel;
            const threshold = (10 - chatRandomLevel) / 10;
            if (Math.random() < threshold) {
                try {
                    await botApi.setMessageReaction(chatId, message_id, reaction);
                    await Store.trackReaction();
                    logReaction(chatId, reaction);
                } catch {}
            }
        } else {
            try {
                await botApi.setMessageReaction(chatId, message_id, reaction);
                await Store.trackReaction();
                logReaction(chatId, reaction);
            } catch {}
        }
    }
}

// ══════════════════════════════════════════════════════════════ END: bot-handler.js

import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import axios from "axios";
import dotenv from "dotenv";
import cron from "node-cron";
import { XMLParser } from "fast-xml-parser";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { getAnimeEmbed } from "./utils.js";

dotenv.config();

// ── Daily Anime News ──────────────────────────────────────────────
const NEWS_CHANNEL = process.env.NEWS_CHANNEL;
const ANN_RSS_URL = "https://www.animenewsnetwork.com/newsroom/rss.xml";
const POSTED_NEWS_FILE = "./posted_news.json";

// Target: 9:00 PM IST = 3:30 PM UTC (IST = UTC+5:30)
// cron format: minute hour day month weekday
const NEWS_CRON = "30 15 * * *"; // 15:30 UTC = 21:00 IST

function loadPostedNews() {
  if (!existsSync(POSTED_NEWS_FILE)) {
    return { lastTitle: "", lastLink: "" };
  }
  try {
    return JSON.parse(readFileSync(POSTED_NEWS_FILE, "utf-8"));
  } catch {
    return { lastTitle: "", lastLink: "" };
  }
}

function savePostedNews(title, link) {
  writeFileSync(POSTED_NEWS_FILE, JSON.stringify({ lastTitle: title, lastLink: link }, null, 2));
}

async function fetchLatestAnimeNews() {
  const response = await axios.get(ANN_RSS_URL, {
    headers: { "User-Agent": "AnimeInfoBot/1.0" },
    timeout: 10000,
  });

  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(response.data);
  const items = parsed?.rss?.channel?.item;

  if (!items || items.length === 0) return null;

  // items can be a single object if only one item exists
  const first = Array.isArray(items) ? items[0] : items;
  return {
    title: first.title || "Untitled",
    link: first.link || "",
    description: stripHtml(first.description || "").slice(0, 400),
    pubDate: first.pubDate || "",
  };
}

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

async function postDailyNews(channel) {
  try {
    const article = await fetchLatestAnimeNews();
    if (!article) {
      console.log("[Daily News] No articles found.");
      return;
    }

    const posted = loadPostedNews();

    // Deduplication: skip if same article was already posted
    if (posted.lastLink === article.link && posted.lastTitle === article.title) {
      console.log("[Daily News] Already posted this article, skipping.");
      return;
    }

    // Fetch the article page for an image
    let imageUrl = null;
    try {
      const pageRes = await axios.get(article.link, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        timeout: 8000,
      });
      const imgMatch = pageRes.data.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
      if (imgMatch) imageUrl = imgMatch[1];
    } catch {
      // no image, that's fine
    }

    let description = article.description || "No summary available.";
    if (description.length >= 400) description = description.slice(0, 397) + "...";

    const embed = new EmbedBuilder()
      .setTitle(article.title)
      .setURL(article.link)
      .setDescription(description)
      .setColor(0xff6600)
      .setTimestamp(new Date(article.pubDate || Date.now()))
      .setFooter({ text: "Daily Anime News • Anime News Network" })
      .setAuthor({ name: "📰 Anime News Network", url: "https://www.animenewsnetwork.com", iconURL: "https://www.animenewsnetwork.com/img/logo_alt.gif" });

    if (imageUrl) embed.setImage(imageUrl);

    await channel.send({ embeds: [embed] });
    savePostedNews(article.title, article.link);
    console.log(`[Daily News] Posted: ${article.title}`);
  } catch (err) {
    console.error("[Daily News] Error posting news:", err.message);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const PREFIX = "!";

// Channel IDs (replace with your actual ones)
const WAIFU_WARS_CHANNEL = process.env.WAIFU_WARS_CHANNEL;
const PERSONAL_WAIFU_CHANNEL = process.env.PERSONAL_WAIFU_CHANNEL;

// NSFW tag slugs from the waifu.im API that should be restricted to NSFW channels
const NSFW_TAG_SLUGS = new Set([
  "ero",
  "ecchi",
  "hentai",
  "milf",
  "oral",
  "paizuri",
  "ass",
  "oppai",
]);

// Fetch all tags from the new waifu.im API
// Returns { nsfwSlugs: Set<string>, slugMap: Map<nameLower, slug>, slugSet: Set<string> }
async function fetchWaifuTags() {
  const { data } = await axios.get("https://api.waifu.im/tags", {
    params: { PageSize: 100 },
  });
  const items = data.items || [];
  const nsfwSlugs = new Set(
    items.filter((t) => NSFW_TAG_SLUGS.has(t.slug)).map((t) => t.slug)
  );
  // Build a case-insensitive name→slug lookup map
  const slugMap = new Map();
  const slugSet = new Set();
  items.forEach((t) => {
    slugMap.set(t.name.toLowerCase(), t.slug);
    slugSet.add(t.slug);
  });
  return { nsfwSlugs, slugMap, slugSet };
}

// Fetch a waifu image from the new waifu.im /images endpoint
// tagSlug: the slug form of the tag (e.g. "maid")
async function fetchWaifu(tagSlug = null, nsfw = false) {
  const params = { PageSize: 1 };
  if (tagSlug) params.IncludedTags = tagSlug;
  if (nsfw) params.IsNsfw = true;
  const { data } = await axios.get("https://api.waifu.im/images", { params });
  return data.items?.[0] || null;
}

client.on("clientReady", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Schedule daily anime news at 9:00 PM IST (15:30 UTC)
  if (NEWS_CHANNEL) {
    cron.schedule(NEWS_CRON, () => {
      const channel = client.channels.cache.get(NEWS_CHANNEL);
      if (channel) {
        postDailyNews(channel);
      } else {
        console.log("[Daily News] Channel not found, trying to fetch...");
        client.channels.fetch(NEWS_CHANNEL).then((ch) => {
          if (ch) postDailyNews(ch);
        }).catch(() => console.error("[Daily News] Could not find news channel."));
      }
    });
    console.log("📰 Daily anime news scheduled for 9:00 PM IST");
  } else {
    console.log("⚠️ NEWS_CHANNEL not set in .env — daily news disabled.");
  }
});

client.on("messageCreate", async (message) => {
  if (!message.content.startsWith(PREFIX) || message.author.bot) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // ----- Anime Search -----
  if (command === "anime") {
    if (args[0] === "id") {
      const malId = args[1];
      if (!malId) return message.reply("Please provide a MyAnimeList ID.");

      try {
        const embed = await getAnimeEmbed(malId);
        message.channel.send({ embeds: [embed] });
      } catch {
        message.reply("Error fetching anime.");
      }
    } else {
      const query = args.join(" ");
      if (!query) return message.reply("Please provide a title.");

      try {
        const { data } = await axios.get("https://api.jikan.moe/v4/anime", {
          params: { q: query, limit: 5 },
        });

        if (!data.data || data.data.length === 0)
          return message.reply("No results found.");

        const embed = new EmbedBuilder()
          .setTitle(`Search results for: ${query}`)
          .setColor(0x1e90ff);

        const row = new ActionRowBuilder();

        data.data.forEach((a) => {
          embed.addFields({
            name: a.title,
            value: `[AniverseHD](https://aniversehd.com/anime/${a.mal_id}) | [MAL](${a.url}) → MAL ID: \`${a.mal_id}\``,
          });

          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`anime_${a.mal_id}`)
              .setLabel(
                a.title.length > 80 ? a.title.slice(0, 77) + "..." : a.title
              )
              .setStyle(ButtonStyle.Primary)
          );
        });

        message.channel.send({ embeds: [embed], components: [row] });
      } catch {
        message.reply("Error searching anime.");
      }
    }
  }

  // ----- Waifu Search -----
  if (command === "waifu") {
    try {
      if (
        ![WAIFU_WARS_CHANNEL, PERSONAL_WAIFU_CHANNEL].includes(
          message.channel.id
        )
      )
        return;

      const { nsfwSlugs, slugMap, slugSet } = await fetchWaifuTags();
      const isNsfwChannel = message.channel.id === PERSONAL_WAIFU_CHANNEL;

      // User can pass either the slug directly (e.g. "maid") or a display name (e.g. "Maid")
      const input = args[0];
      if (!input) {
        // No tag — fetch random SFW waifu
        const waifu = await fetchWaifu(null, false);
        if (!waifu) return message.reply("⚠️ No waifu found.");
        const embed = new EmbedBuilder()
          .setTitle("Here's your waifu ❤️")
          .setImage(waifu.url)
          .setColor("Random")
          .setFooter({
            text: `Tags: ${waifu.tags?.map((t) => t.name).join(", ") || "none"} | Source: waifu.im`,
          });
        return message.channel.send({ embeds: [embed] });
      }

      // Try slug directly first, then fall back to name→slug lookup
      let tagSlug = input.toLowerCase();
      if (!slugSet.has(tagSlug)) {
        // Not a direct slug — try looking up as a display name
        tagSlug = slugMap.get(input.toLowerCase()) || null;
      }

      if (!tagSlug) {
        return message.reply("❌ Invalid tag. Use `!waifutags` to see available tags.");
      }

      if (nsfwSlugs.has(tagSlug) && !isNsfwChannel) {
        return message.reply("🚫 NSFW tags are not allowed in this channel.");
      }

      const nsfw = nsfwSlugs.has(tagSlug);
      const waifu = await fetchWaifu(tagSlug, nsfw);

      if (!waifu) {
        return message.reply("⚠️ No waifus found for that tag.");
      }

      const embed = new EmbedBuilder()
        .setTitle(`Here's your waifu ❤️ ${input ? `(${input})` : ""}`)
        .setImage(waifu.url)
        .setColor("Random")
        .setFooter({
          text: `Tags: ${waifu.tags?.map((t) => t.name).join(", ") || "none"} | Source: waifu.im`,
        });

      message.channel.send({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      message.reply("❌ Something went wrong while fetching a waifu.");
    }
  }

  // ----- Waifu Tags -----
  if (command === "waifutags") {
    try {
      if (
        ![WAIFU_WARS_CHANNEL, PERSONAL_WAIFU_CHANNEL].includes(
          message.channel.id
        )
      )
        return;

      const { nsfwSlugs, slugMap, slugSet } = await fetchWaifuTags();
      const isNsfwChannel = message.channel.id === PERSONAL_WAIFU_CHANNEL;

      // Build slug→name map for display (slugMap is nameLower→slug, invert it)
      const slugToName = new Map();
      slugMap.forEach((slug, nameLower) => {
        slugToName.set(slug, nameLower);
      });

      // Get all slugs, filter NSFW for non-NSFW channels
      let slugs = Array.from(slugSet);
      if (!isNsfwChannel) {
        slugs = slugs.filter((s) => !nsfwSlugs.has(s));
      }

      // Show "Name (slug)" for clarity
      const tagList = slugs
        .map((s) => {
          const name = slugToName.get(s);
          // Capitalize first letter of name for display
          const displayName = name.charAt(0).toUpperCase() + name.slice(1);
          return displayName === s ? s : `${displayName} (\`${s}\`)`;
        })
        .join(", ");

      const embed = new EmbedBuilder()
        .setTitle("📑 Available Waifu Tags")
        .setDescription(tagList)
        .setColor(0xff69b4)
        .setFooter({ text: "Use !waifu <slug> to search, e.g. !waifu maid" });

      message.channel.send({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      message.reply("❌ Failed to fetch waifu tags.");
    }
  }
});

// Handle anime button interactions
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton() || !interaction.customId.startsWith("anime_"))
    return;

  const malId = interaction.customId.replace("anime_", "");
  try {
    const embed = await getAnimeEmbed(malId);
    await interaction.update({ embeds: [embed], components: [] });
  } catch {
    interaction.reply({ content: "Error fetching anime.", ephemeral: true });
  }
});

client.login(process.env.DISCORD_TOKEN);

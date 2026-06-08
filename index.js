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

// ── Hourly Anime News ──────────────────────────────────────────────
const NEWS_CHANNEL = process.env.NEWS_CHANNEL;
const ANN_RSS_URL = "https://www.animenewsnetwork.com/newsroom/rss.xml";
const POSTED_NEWS_FILE = "./posted_news.json";

// Every hour at minute 0
const NEWS_CRON = "0 * * * *";

// Categories considered "trending/top" anime news
const TRENDING_CATS = new Set([
  "Anime", "Manga", "Light Novels", "Games", "Industry", "Events", "Comics", "Music",
]);

// Max stored IDs to keep file small
const MAX_STORED = 100;

function loadPostedIds() {
  if (!existsSync(POSTED_NEWS_FILE)) return new Set();
  try {
    const arr = JSON.parse(readFileSync(POSTED_NEWS_FILE, "utf-8"));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function savePostedIds(ids) {
  const arr = Array.from(ids).slice(-MAX_STORED);
  writeFileSync(POSTED_NEWS_FILE, JSON.stringify(arr));
}

// Extract numeric ID from ANN guid (e.g. ".../.238283" → "238283")
function extractId(guid) {
  if (!guid) return null;
  const m = guid.match(/\.(\d+)\s*$/);
  return m ? m[1] : null;
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

async function fetchAnimeNews() {
  const response = await axios.get(ANN_RSS_URL, {
    headers: { "User-Agent": "AnimeInfoBot/1.0" },
    timeout: 10000,
  });

  const parser = new XMLParser({
    ignoreAttributes: false,
    tagValueProcessor: (tagName, tagValue) =>
      typeof tagValue === "string" ? tagValue.replace(/&amp;/g, "&") : tagValue,
  });
  const parsed = parser.parse(response.data);
  let items = parsed?.rss?.channel?.item;

  if (!items) return [];
  if (!Array.isArray(items)) items = [items];

  return items
    .map((item) => {
      let cats = [];
      if (item.category)
        cats = Array.isArray(item.category) ? item.category : [item.category];
      const guid = item.guid?.["#text"] || item.guid || "";
      return {
        id: extractId(guid),
        guid,
        title: item.title || "Untitled",
        link: item.link || "",
        description: stripHtml(item.description || "").slice(0, 400),
        pubDate: item.pubDate || "",
        categories: cats,
      };
    })
    .filter((a) => a.id); // skip items with no valid ID
}

async function postTrendingNews(channel) {
  try {
    const articles = await fetchAnimeNews();
    if (articles.length === 0) {
      console.log("[Anime News] No articles found, skipping.");
      return;
    }

    const postedIds = loadPostedIds();

    // Filter to trending anime-relevant articles only
    const trending = articles.filter((a) =>
      a.categories.some((c) => TRENDING_CATS.has(c.trim()))
    );

    if (trending.length === 0) {
      console.log("[Anime News] No trending anime articles, skipping.");
      return;
    }

    // Find the newest trending article we haven't posted yet
    let newArticle = null;
    for (const article of trending) {
      if (!postedIds.has(article.id)) {
        newArticle = article;
        break;
      }
    }

    if (!newArticle) {
      console.log("[Anime News] No new trending articles since last check, skipping.");
      return;
    }

    // Fetch og:image from article page
    let imageUrl = null;
    try {
      const pageRes = await axios.get(newArticle.link, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        timeout: 8000,
      });
      const imgMatch = pageRes.data.match(
        /<meta\s+property="og:image"\s+content="([^"]+)"/i
      );
      if (imgMatch) imageUrl = imgMatch[1];
    } catch {}

    let description = newArticle.description || "No summary available.";
    if (description.length >= 400)
      description = description.slice(0, 397) + "...";

    const embed = new EmbedBuilder()
      .setTitle(newArticle.title)
      .setURL(newArticle.link)
      .setDescription(description)
      .setColor(0xff6600)
      .setTimestamp(new Date(newArticle.pubDate || Date.now()))
      .setFooter({
        text: `Trending Anime News • ${newArticle.categories.join(", ")} • Anime News Network`,
      })
      .setAuthor({
        name: "📰 Anime News Network",
        url: "https://www.animenewsnetwork.com",
        iconURL:
          "https://www.animenewsnetwork.com/img/logo_alt.gif",
      });

    if (imageUrl) embed.setImage(imageUrl);

    await channel.send({ embeds: [embed] });

    postedIds.add(newArticle.id);
    savePostedIds(postedIds);

    console.log(`[Anime News] Posted: ${newArticle.title} [id: ${newArticle.id}]`);
  } catch (err) {
    console.error("[Anime News] Error:", err.message);
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

  // Schedule hourly anime news check
  if (NEWS_CHANNEL) {
    cron.schedule(NEWS_CRON, () => {
      const channel = client.channels.cache.get(NEWS_CHANNEL);
      if (channel) {
        postTrendingNews(channel);
      } else {
        console.log("[Anime News] Channel not found, trying to fetch...");
        client.channels.fetch(NEWS_CHANNEL)
          .then((ch) => {
            if (ch) postTrendingNews(ch);
          })
          .catch(() =>
            console.error("[Anime News] Could not find news channel.")
          );
      }
    });
    console.log("📰 Hourly trending anime news scheduled (checks every hour)");
  } else {
    console.log(
      "⚠️ NEWS_CHANNEL not set in .env — hourly anime news disabled."
    );
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

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
import { getAnimeEmbed } from "./utils.js";

dotenv.config();

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

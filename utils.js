import axios from "axios";
import { EmbedBuilder } from "discord.js";

// Reusable function to fetch anime details and return an embed
async function getAnimeEmbed(malId) {
  const { data } = await axios.get(`https://api.jikan.moe/v4/anime/${malId}`);
  const anime = data.data;

  return new EmbedBuilder()
    .setTitle(`${anime.title} (${anime.year || "N/A"})`)
    .setURL(`https://aniversehd.com/anime/${anime.mal_id}`)
    .setColor(0x1e90ff)
    .setImage(anime.images.jpg.image_url)
    .addFields(
      { name: "Episodes", value: `${anime.episodes || "N/A"}`, inline: true },
      { name: "Score", value: `${anime.score || "N/A"}`, inline: true },
      { name: "Genres", value: anime.genres.map(g => g.name).join(", ") || "N/A" },
      { name: "Theme", value: anime.themes.map(t => t.name).join(", ") || "N/A" },
      { name: "Demographics", value: anime.demographics.map(d => d.name).join(", ") || "N/A" },
      { name: "Rating", value: anime.rating || "N/A", inline: true },
      { name: "AniverseHD", value: `[Click Here](https://aniversehd.com/anime/${anime.mal_id})` },
      { name: "MyAnimeList", value: `[Click Here](${anime.url})` }
    )
    .setDescription(anime.synopsis ? `${anime.synopsis.slice(0, 300)}...` : "No synopsis available.");
}

export { getAnimeEmbed };
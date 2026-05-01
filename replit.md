# Bot Discord Arki Roulette

## Overview
This project is a comprehensive Discord bot designed to enhance server engagement and administration. It integrates several key functionalities: an interactive fortune roulette, an automated monthly voting system with rewards, advanced translation and AI-powered text reformulation, and a robust player inventory management system. The bot aims to provide a rich, interactive experience for server members while offering powerful administrative tools through a dedicated web dashboard. The vision is to create a multi-functional bot that streamlines server operations, fosters community interaction, and offers unique gamified experiences.

## User Preferences
I want iterative development.
I prefer detailed explanations for complex features.
I want the agent to ask before making major changes or implementing new features.
I prefer clear and concise communication.
I like code that is well-documented and follows best practices.

## System Architecture
The bot is built on Node.js using Discord.js for Discord API interactions. A web dashboard for administration is implemented with Express and EJS, accessible via port 5000.

**UI/UX Decisions:**
- The dashboard features a clean, responsive design with EJS templates for dynamic content.
- It includes triple authentication (password + Discord OAuth2) for secure access, distinguishing between 'Admin' (full access) and 'Staff' (limited access to Shop, Dino Prices, Inventories) roles.
- The dashboard provides live previews for Discord embeds (Shop, Dino Prices, Vote Messages) to ensure accurate content.
- A toggle for light/dark mode is available, with preference persisted in local storage.

**Technical Implementations:**
- **Roulette:** Generates smooth GIF animations using Canvas and GIF Encoder 2.
- **Monthly Votes:** Integrates with TopServeurs API for vote tracking, distributes diamond rewards directly into the Arki inventory system (no longer via UnbelievaBoat), and generates DraftBot commands. It features automatic result publication via `node-cron`.
- **Shop & Dino Prices:** CRUD operations for packs and dinos are managed via the dashboard. These features support variants, special options (e.g., `isModded`, `isShoulder`, 'Flash Sale'), and categorized publication into Discord embeds.
- **Translation & Reformulation:** Utilizes `@vitalets/google-translate-api` for translations and OpenAI for Kaamelott-style reformulations, triggered by emoji reactions.
- **Inventory System:** Comprehensive management of player inventories (items, currencies, dinos, equipment) with a transaction history, accessible and modifiable through the dashboard and Discord commands.
- **Persistence:** Data is primarily stored in PostgreSQL for Railway deployment, with `Better-SQLite3` used for local data like vote history. JSON files serve as fallbacks for some configurations and data.
- **Configuration Management:** A centralized `settingsManager.js` handles all bot configurations, supporting environment variables and dynamic updates.

**Feature Specifications:**
- **Dashboard Overview:** Displays server stats, members, uptime, and roulette configuration.
- **Vote Rewards:** Configurable diamond amounts per vote, bonus diamonds for top voters, and custom item rewards for top 3.
- **Message Customization:** Allows full customization of vote result messages with live preview.
- **Permissions System:** Role-based access control for bot commands and dashboard features.
- **Giveaway System:** Comprehensive CRUD for giveaways, participant tracking, manual/automatic drawing, and direct item distribution to winners.
- **Welcome System:** Configurable welcome messages and banners with historical visit tracking.
- **Spawn Ticket System:** Full admission flow for new players — modal form (age, platform, gamertag), private ticket channel `spawn-joueur-username`, staff checklist (vocal/registration/starter), in-game password sent via DM, automatic role grant on finalization, welcome & log channel messages. Configurable via Dashboard → Tickets → Spawn Joueur. Slash command: `/spawn-panel`.

## External Dependencies
- **Discord.js:** For interacting with the Discord API.
- **Express & EJS:** Web framework and templating engine for the administration dashboard.
- **Canvas & GIF Encoder 2:** For generating dynamic images and GIF animations (roulette wheel).
- **Axios:** HTTP client for making API requests.
- **PostgreSQL (via `pg`):** Primary database for data persistence on Railway.
- **Better-SQLite3:** Local database for specific data like vote history.
- **unb-api:** Kept for the `/migrer-ub` migration command only. Diamond distribution for votes now uses the internal inventory system directly.
- **OpenAI:** Used for AI-powered text reformulation (Kaamelott style).
- **@vitalets/google-translate-api:** For translation functionalities.
- **node-cron:** For scheduling automated tasks, such as monthly vote publications.
- **TopServeurs API:** For fetching monthly vote rankings and data.
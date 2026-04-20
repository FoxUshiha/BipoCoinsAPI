require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder
} = require("discord.js");

const fs = require("fs");
const axios = require("axios");
const express = require("express");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

// ================= ENVIRONMENT VARIABLES =================
const TOKEN = process.env.TOKEN;
if (!TOKEN) process.exit(1);
const CLIENT_ID = process.env.CLIENT_ID;
if (!CLIENT_ID) console.warn("⚠ CLIENT_ID não definido. Slash commands não serão registrados.");

// Coin API (external) configuration
const COIN_API_URL = process.env.COIN_API_URL || "http://localhost:26450";
const COIN_BOT_CARD = process.env.COIN_BOT_CARD;
const COIN_TO_BIPO_RATE = parseFloat(process.env.COIN_TO_BIPO_RATE || "1000000");
const BIPO_TO_COIN_RATE = parseFloat(process.env.BIPO_TO_COIN_RATE || "0.000001");
const CONVERSION_FEE_PERCENT = parseFloat(process.env.CONVERSION_FEE_PERCENT || "0");

// Bipo API (internal) configuration
const BIPO_API_PORT = parseInt(process.env.BIPO_API_PORT || "26451");
let BIPO_BOT_CARD = process.env.BIPO_BOT_CARD;

// General economy constants
const DAILY_REWARD = 1;
const INTEREST_RATE = 0.05;
const MAX_LOAN = 5000;

// ================= HELPER: TRUNCATE TO 2 DECIMALS (BIPO) =================
function truncateBipo(value) {
  return Math.round(Number(value) * 100) / 100;
}

// ================= HELPER: TRUNCATE TO 8 DECIMALS (COIN) =================
function truncateCoin(value) {
  return Math.round(Number(value) * 1e8) / 1e8;
}

// ================= HELPER: MASK CARD =================
function maskCard(card) {
  if (!card || card.length < 8) return card || "não definido";
  return card.slice(0, 4) + "..." + card.slice(-4);
}

// ================= CORREÇÃO DE SALDOS QUEBRADOS =================
function fixUserBalance(userData) {
  let changed = false;
  if (userData.balance !== undefined) {
    const fixed = truncateBipo(userData.balance);
    if (Math.abs(fixed - userData.balance) > 0.0001) {
      userData.balance = fixed;
      changed = true;
    }
  }
  if (userData.bank !== undefined) {
    const fixed = truncateBipo(userData.bank);
    if (Math.abs(fixed - userData.bank) > 0.0001) {
      userData.bank = fixed;
      changed = true;
    }
  }
  return changed;
}

function fixAllBalances() {
  console.log("🔧 Corrigindo saldos de todos os usuários e banco central...");
  const files = fs.readdirSync("./users");
  let totalUsersFixed = 0;
  for (const file of files) {
    try {
      const user = JSON.parse(fs.readFileSync(`./users/${file}`));
      if (fixUserBalance(user)) {
        fs.writeFileSync(`./users/${file}`, JSON.stringify(user, null, 2));
        totalUsersFixed++;
      }
    } catch (e) {}
  }
  if (fs.existsSync(bankPath)) {
    const bank = JSON.parse(fs.readFileSync(bankPath));
    const fixedBank = truncateBipo(bank.balance);
    if (Math.abs(fixedBank - bank.balance) > 0.0001) {
      bank.balance = fixedBank;
      fs.writeFileSync(bankPath, JSON.stringify(bank, null, 2));
      console.log(`  Banco central corrigido: ${bank.balance} → ${fixedBank}`);
    }
  }
  console.log(`✅ Correção concluída. ${totalUsersFixed} usuários tiveram saldos ajustados.`);
}

// ================= DISCORD CLIENT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ]
});

// ================= FILE PATHS & GLOBAL DATA =================
if (!fs.existsSync("./users")) fs.mkdirSync("./users");
if (!fs.existsSync("./global")) fs.mkdirSync("./global");

const marketPath = "./global/market.json";
if (!fs.existsSync(marketPath)) {
  fs.writeFileSync(marketPath, JSON.stringify({ totalSupply: 0, coinValue: 1, history: [] }, null, 2));
}

const bankPath = "./global/bank.json";
if (!fs.existsSync(bankPath)) {
  fs.writeFileSync(bankPath, JSON.stringify({ balance: 0 }, null, 2));
}

let bipoCardMap = new Map();
let market = [];
let marketId = 1;
const userLocks = new Set();
const userCooldown = new Map();

// ================= USER DATA FUNCTIONS =================
function getUserPath(id) {
  return `./users/${id}.json`;
}

function createUser(user) {
  const path = getUserPath(user.id);
  if (!fs.existsSync(path)) {
    fs.writeFileSync(path, JSON.stringify({
      id: user.id,
      username: user.username,
      balance: 0,
      bank: 0,
      lastDaily: 0,
      loan: null,
      pickaxe: "wood",
      pickaxeDurability: 10,
      ores: {},
      enchants: [],
      coinCard: null,
      bipoCard: null,
      bipoCardHash: null
    }, null, 2));
  }
}

function loadUser(id) {
  return JSON.parse(fs.readFileSync(getUserPath(id)));
}

function saveUser(data) {
  data.balance = truncateBipo(data.balance);
  data.bank = truncateBipo(data.bank);
  fs.writeFileSync(getUserPath(data.id), JSON.stringify(data, null, 2));
}

function rebuildBipoCardMap() {
  const files = fs.readdirSync("./users");
  bipoCardMap.clear();
  for (const file of files) {
    try {
      const user = JSON.parse(fs.readFileSync(`./users/${file}`));
      if (user.bipoCardHash) {
        bipoCardMap.set(user.bipoCardHash, user.id);
      }
    } catch (e) {}
  }
}

function generateCardCode() {
  return crypto.randomBytes(8).toString('hex');
}

function hashCardCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function getOrCreateBipoCard(userId) {
  const user = loadUser(userId);
  if (user.bipoCard) return user.bipoCard;
  const newCode = generateCardCode();
  const newHash = hashCardCode(newCode);
  user.bipoCard = newCode;
  user.bipoCardHash = newHash;
  saveUser(user);
  bipoCardMap.set(newHash, userId);
  return newCode;
}

function resetBipoCard(userId) {
  const user = loadUser(userId);
  if (user.bipoCardHash) bipoCardMap.delete(user.bipoCardHash);
  const newCode = generateCardCode();
  const newHash = hashCardCode(newCode);
  user.bipoCard = newCode;
  user.bipoCardHash = newHash;
  saveUser(user);
  bipoCardMap.set(newHash, userId);
  return newCode;
}

function findUserIdByBipoCard(cardCode) {
  const hash = hashCardCode(cardCode);
  return bipoCardMap.get(hash) || null;
}

// ================= BANK CENTRAL FUNCTIONS =================
function getBankBalance() {
  const bank = JSON.parse(fs.readFileSync(bankPath));
  return bank.balance;
}

function setBankBalance(newBalance) {
  const bank = JSON.parse(fs.readFileSync(bankPath));
  bank.balance = truncateBipo(newBalance);
  fs.writeFileSync(bankPath, JSON.stringify(bank, null, 2));
}

function addBankBalance(amount) {
  const current = getBankBalance();
  setBankBalance(current + amount);
}

function subtractBankBalance(amount) {
  const current = getBankBalance();
  if (current < amount) throw new Error("INSUFFICIENT_BANK_BALANCE");
  setBankBalance(current - amount);
}

// ================= COIN API HELPERS =================
async function getCoinCardInfo(cardCode) {
  try {
    const res = await axios.post(`${COIN_API_URL}/api/card/info`, { cardCode }, { timeout: 10000 });
    if (res.data && res.data.success) return res.data;
    return null;
  } catch (err) {
    console.error("Coin card info error:", err.message);
    return null;
  }
}

async function transferCoinsBetweenCards(fromCard, toCard, amount) {
  try {
    const truncated = truncateCoin(amount);
    const res = await axios.post(`${COIN_API_URL}/api/card/pay`, {
      fromCard,
      toCard,
      amount: truncated
    }, { timeout: 15000 });
    return res.data;
  } catch (err) {
    console.error("Coin transfer error:", err.message);
    return { success: false, error: err.response?.data?.error || err.message };
  }
}

// ================= BIPO CARD API =================
const bipoApp = express();
bipoApp.use(express.json());

bipoApp.post("/api/card/info", async (req, res) => {
  const { cardCode } = req.body;
  if (!cardCode) return res.status(400).json({ success: false, error: "Missing cardCode" });
  const userId = findUserIdByBipoCard(cardCode);
  if (!userId) return res.status(404).json({ success: false, error: "Card not found" });
  const user = loadUser(userId);
  const lastClaimTs = user.lastDaily || 0;
  const cooldownMs = 86400000;
  const cooldownRemainingMs = Math.max(0, (lastClaimTs + cooldownMs) - Date.now());
  res.json({
    success: true,
    userId: user.id,
    coins: user.balance,
    sats: 0,
    totalTransactions: 0,
    lastClaimTs,
    cooldownRemainingMs,
    cooldownMs
  });
});

bipoApp.post("/api/card/pay", async (req, res) => {
  const { fromCard, toCard, amount } = req.body;
  if (!fromCard || !toCard || !amount || amount <= 0) {
    return res.status(400).json({ success: false, error: "Invalid parameters" });
  }
  const fromUserId = findUserIdByBipoCard(fromCard);
  const toUserId = findUserIdByBipoCard(toCard);
  if (!fromUserId) return res.status(404).json({ success: false, error: "FROM_CARD_NOT_FOUND" });
  if (!toUserId) return res.status(404).json({ success: false, error: "TO_CARD_NOT_FOUND" });
  const fromUser = loadUser(fromUserId);
  const toUser = loadUser(toUserId);
  const truncatedAmount = truncateBipo(amount);
  if (fromUser.balance < truncatedAmount) {
    return res.status(402).json({ success: false, error: "INSUFFICIENT_FUNDS" });
  }
  fromUser.balance = truncateBipo(fromUser.balance - truncatedAmount);
  toUser.balance = truncateBipo(toUser.balance + truncatedAmount);
  saveUser(fromUser);
  saveUser(toUser);
  const txId = uuidv4();
  res.json({ success: true, txId, date: new Date().toISOString() });
});

bipoApp.post("/api/card/claim", async (req, res) => {
  const { cardCode } = req.body;
  if (!cardCode) return res.status(400).json({ success: false, error: "Missing cardCode" });
  const userId = findUserIdByBipoCard(cardCode);
  if (!userId) return res.status(404).json({ success: false, error: "CARD_NOT_FOUND" });
  const user = loadUser(userId);
  const now = Date.now();
  const cooldownMs = 86400000;
  if (user.lastDaily && (now - user.lastDaily) < cooldownMs) {
    const remaining = cooldownMs - (now - user.lastDaily);
    return res.status(429).json({
      success: false,
      error: "COOLDOWN_ACTIVE",
      nextClaimInMs: remaining,
      cooldownMs: cooldownMs,
      lastClaimTs: user.lastDaily
    });
  }
  const TAX_RATE = 0.02;
  const tax = truncateBipo(DAILY_REWARD * TAX_RATE);
  const finalReward = truncateBipo(DAILY_REWARD - tax);
  user.balance = truncateBipo(user.balance + finalReward);
  user.lastDaily = now;
  saveUser(user);
  addBankBalance(tax);
  res.json({
    success: true,
    claimed: finalReward,
    tax: tax,
    newBalance: user.balance,
    nextClaimInMs: cooldownMs
  });
});

bipoApp.listen(BIPO_API_PORT, "0.0.0.0", () => {
  console.log(`🏦 Bipo Card API running on port ${BIPO_API_PORT}`);
});

if (!BIPO_BOT_CARD) {
  const botBipoCardPath = "./global/bot_bipo_card.json";
  if (fs.existsSync(botBipoCardPath)) {
    const data = JSON.parse(fs.readFileSync(botBipoCardPath));
    BIPO_BOT_CARD = data.cardCode;
  } else {
    const newCard = generateCardCode();
    fs.writeFileSync(botBipoCardPath, JSON.stringify({ cardCode: newCard }));
    BIPO_BOT_CARD = newCard;
    console.log(`🆕 Generated BIPO_BOT_CARD: ${newCard}`);
  }
}

// ================= INTERNAL BOT API =================
const internalApi = express();
internalApi.use(express.json());

internalApi.get("/user/:id", (req, res) => {
  try {
    const user = loadUser(req.params.id);
    if (!user) return res.status(404).json({ erro: "Usuário não encontrado" });
    res.json({
      id: user.id,
      username: user.username,
      balance: user.balance,
      bank: user.bank,
      externalCoins: 0
    });
  } catch {
    res.status(500).json({ erro: "Erro interno" });
  }
});

internalApi.post("/pix", (req, res) => {
  const { from, to, amount } = req.body;
  let userFrom = loadUser(from);
  let userTo = loadUser(to);
  if (!userFrom || !userTo) return res.status(404).json({ erro: "Usuários inválidos" });
  if (userFrom.balance < amount) return res.status(400).json({ erro: "Saldo insuficiente" });
  userFrom.balance = truncateBipo(userFrom.balance - amount);
  userTo.balance = truncateBipo(userTo.balance + amount);
  saveUser(userFrom);
  saveUser(userTo);
  res.json({ sucesso: true });
});

internalApi.get("/economia", (req, res) => {
  const marketData = JSON.parse(fs.readFileSync(marketPath));
  const bankData = JSON.parse(fs.readFileSync(bankPath));
  res.json({
    coinValue: marketData.coinValue,
    totalSupply: marketData.totalSupply,
    bank: bankData.balance
  });
});

internalApi.listen(10058, "0.0.0.0", () => {
  console.log("🌐 Merlin API (BOT) rodando na porta 10058");
});

// ================= DISCORD COMMANDS =================
function progressBar(current, max) {
  const totalBars = 10;
  const percentage = current / max;
  const filledBars = Math.round(totalBars * percentage);
  const emptyBars = totalBars - filledBars;
  return "🟥".repeat(filledBars) + "⬛".repeat(emptyBars);
}

function getRandomOre() {
  const roll = Math.random() * 100000;
  if (roll < 1) return "🌌 Éter";
  if (roll < 5) return "☀️ Oricalco";
  if (roll < 15) return "🔥 Netherite";
  if (roll < 40) return "🟡 Adamantita";
  if (roll < 80) return "💎 Diamante";
  if (roll < 150) return "🟣 Obsidiana";
  if (roll < 300) return "🔷 Mythril";
  if (roll < 600) return "🟢 Esmeralda";
  if (roll < 1200) return "🔵 Safira";
  if (roll < 2500) return "🔴 Rubi";
  if (roll < 6000) return "⚙ Platina";
  if (roll < 12000) return "🥇 Ouro";
  if (roll < 20000) return "🥈 Prata";
  if (roll < 35000) return "🟤 Bronze";
  if (roll < 55000) return "⛓ Ferro";
  if (roll < 75000) return "🟫 Cobre";
  if (roll < 95000) return "⚫ Carvão";
  return "🪨 Pedra";
}

const pickaxes = {
  wood: { name: "🪵 Madeira", min: 0.1, max: 0.2, luck: 5, durability: 10 },
  stone: { name: "🪨 Pedra", min: 0.2, max: 0.5, luck: 8, durability: 15 },
  iron: { name: "⛓ Ferro", min: 0.4, max: 1.6, luck: 12, durability: 25 },
  silver: { name: "🥈 Prata", min: 0.8, max: 2.2, luck: 15, durability: 30 },
  gold: { name: "🥇 Ouro", min: 1, max: 3, luck: 18, durability: 35 },
  platinum: { name: "⚙ Platina", min: 1.5, max: 4, luck: 20, durability: 40 },
  ruby: { name: "🔴 Rubi", min: 2, max: 5, luck: 25, durability: 50 },
  sapphire: { name: "🔵 Safira", min: 2.5, max: 6, luck: 28, durability: 60 },
  emerald: { name: "🟢 Esmeralda", min: 3, max: 7, luck: 30, durability: 70 },
  diamond: { name: "💎 Diamante", min: 3.5, max: 8, luck: 35, durability: 80 },
  mythril: { name: "🔷 Mythril", min: 4, max: 10, luck: 40, durability: 90 },
  adamantite: { name: "🟡 Adamantita", min: 5, max: 12, luck: 45, durability: 110 },
  netherite: { name: "🔥 Netherite", min: 6, max: 15, luck: 50, durability: 130 },
  orichalcum: { name: "☀️ Oricalco", min: 8, max: 18, luck: 60, durability: 160 },
  ether: { name: "🌌 Éter", min: 10, max: 25, luck: 75, durability: 200 }
};

async function safeEdit(message, contentOrOptions) {
  try {
    const fetched = await message.channel.messages.fetch(message.id);
    await fetched.edit(contentOrOptions);
  } catch (err) {
    console.error("Erro ao editar mensagem (safeEdit):", err);
    if (typeof contentOrOptions === 'string') {
      await message.channel.send(contentOrOptions);
    } else {
      await message.channel.send(contentOrOptions);
    }
  }
}

// ================= COMMON COMMAND HANDLERS =================
async function handleSaldo(interactionOrMessage, user, userData, isSlash = true) {
  let loanInfo = "Nenhuma";
  if (userData.loan) {
    const totalDebt = Math.floor(userData.loan.amount * (1 + INTEREST_RATE));
    loanInfo = `${totalDebt}\n${progressBar(userData.loan.amount, totalDebt)}`;
  }
  let coinBalance = "Não definido";
  if (userData.coinCard) {
    const info = await getCoinCardInfo(userData.coinCard);
    if (info && info.success) {
      const coinsNum = Number(info.coins);
      coinBalance = isNaN(coinsNum) ? "Erro" : coinsNum.toFixed(8);
    } else {
      coinBalance = "Erro ao consultar";
    }
  }
  const embed = new EmbedBuilder()
    .setColor("Gold")
    .setTitle(`💰 ${user.username}`)
    .addFields(
      { name: "💵 Bipo Carteira", value: `${userData.balance.toFixed(2)}`, inline: true },
      { name: "🏦 Bipo Banco", value: `${userData.bank.toFixed(2)}`, inline: true },
      { name: "💳 Dívida", value: loanInfo, inline: true },
      { name: "🪙 Coin Card", value: maskCard(userData.coinCard) || "Não definido", inline: false },
      { name: "💎 Saldo Coin", value: `${coinBalance}`, inline: true }
    );
  if (isSlash) {
    if (interactionOrMessage.replied || interactionOrMessage.deferred) await interactionOrMessage.editReply({ embeds: [embed] });
    else await interactionOrMessage.reply({ embeds: [embed] });
  } else {
    await interactionOrMessage.reply({ embeds: [embed] });
  }
}

async function handleDaily(interactionOrMessage, user, userData, isSlash = true) {
  const DAILY_COOLDOWN = 86400000;
  if (Date.now() - userData.lastDaily < DAILY_COOLDOWN) {
    const errMsg = "⏳ Você já coletou hoje.";
    if (isSlash) {
      if (interactionOrMessage.replied || interactionOrMessage.deferred) await interactionOrMessage.editReply(errMsg);
      else await interactionOrMessage.reply(errMsg);
    } else {
      await interactionOrMessage.reply(errMsg);
    }
    return;
  }
  const TAX_RATE = 0.02;
  const tax = parseFloat((DAILY_REWARD * TAX_RATE).toFixed(2));
  const finalReward = parseFloat((DAILY_REWARD - tax).toFixed(2));
  if (isSlash) {
    if (interactionOrMessage.replied || interactionOrMessage.deferred) await interactionOrMessage.editReply("🎁 Preparando recompensa...");
    else await interactionOrMessage.reply("🎁 Preparando recompensa...");
  } else {
    await interactionOrMessage.reply("🎁 Preparando recompensa...");
  }
  setTimeout(() => {
    let bank = JSON.parse(fs.readFileSync(bankPath));
    userData.balance = truncateBipo(userData.balance + finalReward);
    userData.lastDaily = Date.now();
    bank.balance = truncateBipo(bank.balance + tax);
    saveUser(userData);
    fs.writeFileSync(bankPath, JSON.stringify(bank, null, 2));
    let marketData = JSON.parse(fs.readFileSync(marketPath));
    marketData.totalSupply += finalReward;
    marketData.coinValue = 1 + (marketData.totalSupply / 10000);
    marketData.history.push({ time: Date.now(), value: marketData.coinValue });
    fs.writeFileSync(marketPath, JSON.stringify(marketData, null, 2));
    const finalMsg = `🎉 Você recebeu **${finalReward.toFixed(2)} moedas!**\n🏦 Taxa do Banco: ${tax.toFixed(2)} coins`;
    if (isSlash) {
      if (interactionOrMessage.editReply) interactionOrMessage.editReply(finalMsg);
      else interactionOrMessage.channel.send(finalMsg);
    } else {
      interactionOrMessage.channel.send(finalMsg);
    }
  }, 1500);
}

// ================= SLASH COMMANDS REGISTRATION =================
const commands = [
  new SlashCommandBuilder().setName("saldo").setDescription("Mostra seu saldo em Bipo Coins e Coins externos"),
  new SlashCommandBuilder().setName("daily").setDescription("Receba sua recompensa diária"),
  new SlashCommandBuilder().setName("minerar").setDescription("Mine Bipo Coins e encontre minérios"),
  new SlashCommandBuilder().setName("loja").setDescription("Exibe a loja de picaretas"),
  new SlashCommandBuilder().setName("comprar").setDescription("Compra uma picareta da loja").addStringOption(opt => opt.setName("item").setDescription("Nome da picareta").setRequired(true)),
  new SlashCommandBuilder().setName("craft").setDescription("Cria uma picareta usando minérios").addStringOption(opt => opt.setName("tipo").setDescription("Tipo da picareta").setRequired(true)),
  new SlashCommandBuilder().setName("raid").setDescription("Entra em uma raid").addStringOption(opt => opt.setName("tipo").setDescription("cave, mine, crystal, abyss, core").setRequired(true).addChoices({ name:"Cave", value:"cave" }, { name:"Mine", value:"mine" }, { name:"Crystal", value:"crystal" }, { name:"Abyss", value:"abyss" }, { name:"Core", value:"core" })),
  new SlashCommandBuilder().setName("pix").setDescription("Transfere Bipo Coins para outro usuário").addUserOption(opt => opt.setName("usuario").setDescription("Destinatário").setRequired(true)).addNumberOption(opt => opt.setName("valor").setDescription("Quantia").setRequired(true)),
  new SlashCommandBuilder().setName("ranking").setDescription("Exibe o ranking global"),
  new SlashCommandBuilder().setName("inventario").setDescription("Mostra seus minérios coletados"),
  new SlashCommandBuilder().setName("grafico").setDescription("Mostra gráfico da economia global"),
  new SlashCommandBuilder().setName("banco").setDescription("Mostra saldo do cofre global"),
  new SlashCommandBuilder().setName("emprestimo").setDescription("Gerencia empréstimos").addSubcommand(sub => sub.setName("pegar").setDescription("Pega um empréstimo").addNumberOption(opt => opt.setName("valor").setDescription("Quantia").setRequired(true))).addSubcommand(sub => sub.setName("pagar").setDescription("Paga parte da dívida").addNumberOption(opt => opt.setName("valor").setDescription("Quantia").setRequired(true))).addSubcommand(sub => sub.setName("status").setDescription("Mostra o status da dívida")),
  new SlashCommandBuilder().setName("mercado").setDescription("Lista itens à venda no mercado"),
  new SlashCommandBuilder().setName("vender").setDescription("Coloca um minério à venda").addStringOption(opt => opt.setName("minerio").setDescription("Nome do minério").setRequired(true)).addNumberOption(opt => opt.setName("quantidade").setDescription("Quantidade").setRequired(true)).addNumberOption(opt => opt.setName("preco").setDescription("Preço total").setRequired(true)),
  new SlashCommandBuilder().setName("compraritem").setDescription("Compra um item do mercado").addIntegerOption(opt => opt.setName("id").setDescription("ID do item").setRequired(true)),
  new SlashCommandBuilder().setName("picaretas").setDescription("Ranking das picaretas"),
  new SlashCommandBuilder().setName("encantar").setDescription("Gira um encantamento para sua picareta"),
  new SlashCommandBuilder().setName("encantamentos").setDescription("Lista todos os encantamentos"),
  new SlashCommandBuilder().setName("ajuda").setDescription("Central de comandos interativa"),
  new SlashCommandBuilder().setName("coincard").setDescription("Define ou mostra seu card Coin (DM)").addStringOption(opt => opt.setName("codigo").setDescription("Código do card Coin").setRequired(false)),
  new SlashCommandBuilder().setName("bipo_card").setDescription("Mostra seu card Bipo (DM)"),
  new SlashCommandBuilder().setName("bipo_card_reset").setDescription("Reseta seu card Bipo (DM)"),
  new SlashCommandBuilder().setName("converter").setDescription("Converte entre Bipo e Coin").addStringOption(opt => opt.setName("de").setDescription("Moeda de origem").setRequired(true).addChoices({ name:"Bipo", value:"bipo" }, { name:"Coin", value:"coin" })).addStringOption(opt => opt.setName("para").setDescription("Moeda de destino").setRequired(true).addChoices({ name:"Coin", value:"coin" }, { name:"Bipo", value:"bipo" })).addNumberOption(opt => opt.setName("quantia").setDescription("Valor").setRequired(true))
];

if (CLIENT_ID) {
  client.once("ready", async () => {
    try {
      await client.application.commands.set(commands);
      console.log("✅ Slash commands registrados globalmente.");
    } catch (err) {
      console.error("❌ Erro ao registrar slash commands:", err);
    }
  });
} else {
  console.warn("⚠ CLIENT_ID não fornecido. Slash commands não serão registrados.");
}

// ================= SLASH COMMAND HANDLER =================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;
  const { commandName, options, user } = interaction;
  createUser(user);
  let userData = loadUser(user.id);
  const isDM = !interaction.guildId;

  try {
    switch (commandName) {
      case "saldo": await handleSaldo(interaction, user, userData, true); break;
      case "daily": await handleDaily(interaction, user, userData, true); break;
      case "minerar": await handleMinerar(interaction, user, userData); break;
      case "loja": await handleLoja(interaction); break;
      case "comprar": await handleComprar(interaction, userData); break;
      case "craft": await handleCraft(interaction, userData); break;
      case "raid": await handleRaid(interaction, userData); break;
      case "pix": await handlePix(interaction, userData); break;
      case "ranking": await handleRanking(interaction); break;
      case "inventario": await handleInventario(interaction, userData); break;
      case "grafico": await handleGrafico(interaction); break;
      case "banco": await handleBanco(interaction); break;
      case "emprestimo": await handleEmprestimo(interaction, userData); break;
      case "mercado": await handleMercado(interaction); break;
      case "vender": await handleVender(interaction, userData); break;
      case "compraritem": await handleComprarItem(interaction, userData); break;
      case "picaretas": await handlePicaretas(interaction); break;
      case "encantar": await handleEncantar(interaction, userData); break;
      case "encantamentos": await handleEncantamentos(interaction); break;
      case "ajuda": await handleAjuda(interaction); break;
      case "coincard":
        if (!isDM) return interaction.reply({ content: "❌ Use este comando no DM.", ephemeral: true });
        await handleCoinCard(interaction, userData);
        break;
      case "bipo_card":
        if (!isDM) return interaction.reply({ content: "❌ Use este comando no DM.", ephemeral: true });
        await handleBipoCard(interaction, userData);
        break;
      case "bipo_card_reset":
        if (!isDM) return interaction.reply({ content: "❌ Use este comando no DM.", ephemeral: true });
        await handleBipoCardReset(interaction, userData);
        break;
      case "converter":
        await handleConverter(interaction, userData);
        break;
      default:
        await interaction.reply({ content: "Comando não implementado.", ephemeral: true });
    }
  } catch (err) {
    console.error(`Erro no comando /${commandName}:`, err);
    if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: "❌ Ocorreu um erro interno.", ephemeral: true });
    else if (interaction.deferred) await interaction.editReply({ content: "❌ Ocorreu um erro interno." });
  }
});

// ================= SLASH COMMAND IMPLEMENTATIONS =================
async function handleMinerar(interaction, user, userData) {
  await interaction.deferReply();
  const cooldownTime = 600000;
  const key = `${user.id}_minerar`;
  if (userCooldown.has(key)) {
    const timePassed = Date.now() - userCooldown.get(key);
    if (timePassed < cooldownTime) {
      const remaining = Math.ceil((cooldownTime - timePassed) / 1000);
      return interaction.editReply(`⛔ Aguarde **${remaining}s** para minerar novamente.`);
    }
  }
  userCooldown.set(key, Date.now());
  const pickaxe = pickaxes[userData.pickaxe] || pickaxes.wood;
  if (!userData.pickaxeDurability) userData.pickaxeDurability = pickaxe.durability;
  const miningMsg = await interaction.editReply("⛏ Iniciando mineração...");
  const stages = ["⛏ Quebrando pedra...", "🪨 Procurando minerais...", "💎 Analisando veios...", "🔍 Escavando fundo..."];
  let step = 0;
  const animation = setInterval(() => {
    miningMsg.edit(stages[step % stages.length]);
    step++;
  }, 800);
  setTimeout(() => {
    clearInterval(animation);
    let amount = Math.random() * (pickaxe.max - pickaxe.min) + pickaxe.min;
    amount = truncateBipo(amount);
    let eventText = "";
    if (Math.random() * 100 < pickaxe.luck) {
      amount = truncateBipo(amount * 2);
      eventText += "\n🍀 **SORTE! Veio rico encontrado!**";
    }
    const oreFound = getRandomOre();
    if (!userData.ores) userData.ores = {};
    userData.ores[oreFound] = (userData.ores[oreFound] || 0) + 1;
    userData.balance = truncateBipo(userData.balance + amount);
    userData.pickaxeDurability -= 1;
    let breakText = "";
    if (userData.pickaxeDurability <= 0) {
      breakText = `\n💥 Sua picareta ${pickaxe.name} quebrou!`;
      userData.pickaxe = "wood";
      userData.pickaxeDurability = pickaxes.wood.durability;
    }
    saveUser(userData);
    const durabilityPercent = userData.pickaxeDurability / pickaxe.durability;
    const greenBars = Math.round(10 * durabilityPercent);
    const durabilityBar = "🟩".repeat(greenBars) + "⬛".repeat(10 - greenBars);
    const embed = new EmbedBuilder()
      .setColor("#2ecc71")
      .setTitle("⛏ Resultado da Mineração")
      .setDescription(`💰 Você minerou **${amount.toFixed(2)} coins**\n🪨 Encontrou: **${oreFound}**${eventText}${breakText}`)
      .addFields(
        { name: "⛏ Picareta", value: pickaxe.name, inline: true },
        { name: "🔧 Durabilidade", value: `${durabilityBar}\n${userData.pickaxeDurability}`, inline: true },
        { name: "💳 Saldo", value: `${userData.balance.toFixed(2)} coins`, inline: true }
      )
      .setFooter({ text: "Sistema de Mineração Bipo ⛏" })
      .setTimestamp();
    miningMsg.edit({ content: "", embeds: [embed] });
  }, 3500);
}

async function handleLoja(interaction) {
  const embed = new EmbedBuilder()
    .setColor("#2ecc71")
    .setTitle("🛒 Loja de Picaretas")
    .setDescription(`Use **/comprar item:<nome>**`)
    .setThumbnail(client.user.displayAvatarURL());
  Object.entries(pickaxes).forEach(([id, p]) => {
    const durabilityBars = Math.round(p.durability / 20);
    const bar = "🟩".repeat(Math.min(durabilityBars, 10)) + "⬛".repeat(10 - Math.min(durabilityBars, 10));
    embed.addFields({
      name: `${p.name} (${id})`,
      value: `💰 **Preço:** ${id === "wood" ? 0 : Math.floor(p.durability * 0.5)} coins\n🔧 **Durabilidade:** ${p.durability}\n📊 ${bar}`,
      inline: true
    });
  });
  await interaction.reply({ embeds: [embed] });
}

async function handleComprar(interaction, userData) {
  const item = interaction.options.getString("item");
  if (!item || !pickaxes[item]) return interaction.reply({ content: "❌ Picareta inválida.", ephemeral: true });
  const price = item === "wood" ? 0 : Math.floor(pickaxes[item].durability * 0.5);
  if (userData.balance < price) return interaction.reply({ content: "❌ Saldo insuficiente.", ephemeral: true });
  userData.balance = truncateBipo(userData.balance - price);
  userData.pickaxe = item;
  userData.pickaxeDurability = pickaxes[item].durability;
  saveUser(userData);
  await interaction.reply(`✅ Você comprou ${pickaxes[item].name}!`);
}

async function handleCraft(interaction, userData) {
  const recipes = {
    iron: { name: "⛓ Picareta de Ferro", cost: { "⛓ Ferro": 5, "🪨 Pedra": 10 } },
    silver: { name: "🥈 Picareta de Prata", cost: { "🥈 Prata": 6, "⛓ Ferro": 3 } },
    gold: { name: "🥇 Picareta de Ouro", cost: { "🥇 Ouro": 6, "🥈 Prata": 4 } },
    platinum: { name: "⚙ Picareta de Platina", cost: { "⚙ Platina": 5, "🥇 Ouro": 3 } },
    ruby: { name: "🔴 Picareta de Rubi", cost: { "🔴 Rubi": 4, "⚙ Platina": 3 } },
    sapphire: { name: "🔵 Picareta de Safira", cost: { "🔵 Safira": 4, "⚙ Platina": 3 } },
    emerald: { name: "🟢 Picareta de Esmeralda", cost: { "🟢 Esmeralda": 4, "🔵 Safira": 2 } },
    diamond: { name: "💎 Picareta de Diamante", cost: { "💎 Diamante": 4, "🟣 Obsidiana": 2 } },
    mythril: { name: "🔷 Picareta de Mythril", cost: { "🔷 Mythril": 3, "💎 Diamante": 2 } },
    adamantite: { name: "🟡 Picareta de Adamantita", cost: { "🟡 Adamantita": 4, "🔷 Mythril": 2 } },
    netherite: { name: "🔥 Picareta de Netherite", cost: { "🔥 Netherite": 2, "🟡 Adamantita": 2 } },
    orichalcum: { name: "☀️ Picareta de Oricalco", cost: { "☀️ Oricalco": 2, "🔥 Netherite": 2 } },
    ether: { name: "🌌 Picareta de Éter", cost: { "🌌 Éter": 1, "☀️ Oricalco": 2 } }
  };
  const type = interaction.options.getString("tipo");
  if (!type || !recipes[type]) return interaction.reply({ content: "❌ Picareta inválida.", ephemeral: true });
  const recipe = recipes[type];
  const inventory = userData.ores || {};
  for (const ore in recipe.cost) {
    if ((inventory[ore] || 0) < recipe.cost[ore]) return interaction.reply({ content: `❌ Você precisa de **${recipe.cost[ore]} ${ore}**`, ephemeral: true });
  }
  for (const ore in recipe.cost) inventory[ore] -= recipe.cost[ore];
  userData.pickaxe = type;
  saveUser(userData);
  const embed = new EmbedBuilder().setColor("#2ecc71").setTitle("⚒ Craft realizado!").setDescription(`Você criou **${recipe.name}**`);
  await interaction.reply({ embeds: [embed] });
}

async function handleRaid(interaction, userData) {
  const RAIDS = {
    cave: { name: "🕳 Caverna Abandonada", price: 3, time: 30000, ores: 6 },
    mine: { name: "⛏ Mina Profunda", price: 5, time: 60000, ores: 10 },
    crystal: { name: "💎 Templo de Cristal", price: 7, time: 90000, ores: 14 },
    abyss: { name: "🌑 Abismo Antigo", price: 10, time: 120000, ores: 18 },
    core: { name: "🔥 Núcleo da Terra", price: 20, time: 180000, ores: 25 }
  };
  const type = interaction.options.getString("tipo");
  const raid = RAIDS[type];
  if (!raid) return interaction.reply({ content: "Raids: cave, mine, crystal, abyss, core", ephemeral: true });
  if (userData.balance < raid.price) return interaction.reply({ content: "❌ Coins insuficientes.", ephemeral: true });
  userData.balance = truncateBipo(userData.balance - raid.price);
  const pickaxe = pickaxes[userData.pickaxe] || pickaxes.wood;
  if (!userData.pickaxeDurability) userData.pickaxeDurability = pickaxe.durability;
  await interaction.reply(`🚪 Entrando na raid ${raid.name}...`);
  setTimeout(async () => {
    let mined = [];
    let inventory = userData.ores || {};
    for (let i = 0; i < raid.ores; i++) {
      const ore = getRandomOre();
      inventory[ore] = (inventory[ore] || 0) + 1;
      mined.push(ore);
      userData.pickaxeDurability -= 1;
    }
    userData.ores = inventory;
    let broken = false;
    if (userData.pickaxeDurability <= 0) {
      broken = true;
      userData.pickaxe = "wood";
      userData.pickaxeDurability = pickaxes.wood.durability;
    }
    saveUser(userData);
    await interaction.editReply(`🏆 **RAID CONCLUÍDA**\n🪨 Minérios obtidos: ${mined.join(" ")}\n⛏ Durabilidade restante: ${userData.pickaxeDurability}/${pickaxe.durability}\n${broken ? "💥 Sua picareta quebrou!" : ""}`);
  }, raid.time);
}

async function handlePix(interaction, userData) {
  const target = interaction.options.getUser("usuario");
  const amount = interaction.options.getNumber("valor");
  if (!target || target.bot || target.id === interaction.user.id) return interaction.reply({ content: "❌ Destinatário inválido.", ephemeral: true });
  if (isNaN(amount) || amount <= 0 || amount > 100000000) return interaction.reply({ content: "❌ Valor inválido.", ephemeral: true });
  createUser(target);
  let targetData = loadUser(target.id);
  if (userData.balance < amount) return interaction.reply({ content: "❌ Saldo insuficiente.", ephemeral: true });
  const TAX_RATE = 0.02;
  const tax = truncateBipo(amount * TAX_RATE);
  const finalAmount = truncateBipo(amount - tax);
  const confirmEmbed = new EmbedBuilder()
    .setColor("#00ff99")
    .setTitle("💸 CONFIRMAR TRANSFERÊNCIA")
    .setDescription("Digite **sim** para confirmar ou **cancelar**")
    .addFields(
      { name: "👤 Destinatário", value: target.username, inline: true },
      { name: "💰 Valor", value: `${amount.toFixed(2)} coins`, inline: true },
      { name: "🏦 Taxa", value: `${tax.toFixed(2)} coins`, inline: true }
    );
  await interaction.reply({ embeds: [confirmEmbed] });
  const filter = m => m.author.id === interaction.user.id && ["sim", "cancelar"].includes(m.content.toLowerCase());
  const collector = interaction.channel.createMessageCollector({ filter, time: 15000, max: 1 });
  collector.on("collect", async (msg) => {
    if (msg.content.toLowerCase() === "cancelar") return interaction.followUp("❌ Transferência cancelada.");
    const loading = await interaction.followUp("💸 Processando.");
    setTimeout(() => {
      let bank = JSON.parse(fs.readFileSync(bankPath));
      userData.balance = truncateBipo(userData.balance - amount);
      targetData.balance = truncateBipo(targetData.balance + finalAmount);
      bank.balance = truncateBipo(bank.balance + tax);
      saveUser(userData);
      saveUser(targetData);
      fs.writeFileSync(bankPath, JSON.stringify(bank, null, 2));
      loading.edit("✅ PIX realizado com sucesso!");
    }, 2500);
  });
  collector.on("end", collected => { if (collected.size === 0) interaction.followUp("⏳ Tempo esgotado."); });
}

async function handleRanking(interaction) {
  const loadRanking = () => {
    const files = fs.readdirSync("./users");
    let ranking = [];
    files.forEach(file => {
      const data = JSON.parse(fs.readFileSync(`./users/${file}`));
      ranking.push({ username: data.username, balance: data.balance || 0, bank: data.bank || 0, total: (data.balance || 0) + (data.bank || 0) });
    });
    ranking.sort((a,b) => b.total - a.total);
    return ranking;
  };
  let ranking = loadRanking();
  const generateEmbed = (type) => {
    let sorted;
    if (type === "bank") sorted = [...ranking].sort((a,b) => b.bank - a.bank);
    else if (type === "mineracao") sorted = [...ranking].sort((a,b) => b.balance - a.balance);
    else sorted = [...ranking];
    const embed = new EmbedBuilder().setColor("#8A2BE2").setTitle("🏆 Ranking Bipo Coins").setDescription(`Categoria: **${type}**`);
    sorted.slice(0,10).forEach((u,i) => {
      let medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "👑";
      embed.addFields({ name: `#${i+1} ${medal} ${u.username}`, value: `💰 ${u.total.toFixed(2)} coins` });
    });
    return embed;
  };
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("rank_global").setLabel("🌍 Global").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("rank_bank").setLabel("🏦 Banco").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rank_mineracao").setLabel("⛏ Mineração").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("rank_refresh").setLabel("🔄 Atualizar").setStyle(ButtonStyle.Danger)
  );
  const msg = await interaction.reply({ embeds: [generateEmbed("global")], components: [row] });
  const collector = msg.createMessageComponentCollector({ time: 60000 });
  collector.on("collect", async (btnInteraction) => {
    if (btnInteraction.user.id !== interaction.user.id) return btnInteraction.reply({ content: "❌ Apenas quem abriu pode usar.", ephemeral: true });
    if (btnInteraction.customId === "rank_refresh") ranking = loadRanking();
    let embed;
    if (btnInteraction.customId === "rank_global") embed = generateEmbed("global");
    else if (btnInteraction.customId === "rank_bank") embed = generateEmbed("bank");
    else if (btnInteraction.customId === "rank_mineracao") embed = generateEmbed("mineracao");
    else embed = generateEmbed("global");
    btnInteraction.update({ embeds: [embed], components: [row] });
  });
}

async function handleInventario(interaction, userData) {
  const inventory = userData.ores || {};
  const oresList = Object.entries(inventory);
  if (oresList.length === 0) return interaction.reply("🎒 Inventário vazio.");
  const embed = new EmbedBuilder().setColor("#8e44ad").setTitle(`🎒 Inventário de ${interaction.user.username}`).setDescription("Minérios coletados").setTimestamp();
  oresList.forEach(([ore, amount]) => embed.addFields({ name: ore, value: `Quantidade: **${amount}**`, inline: true }));
  await interaction.reply({ embeds: [embed] });
}

async function handleGrafico(interaction) {
  const marketData = JSON.parse(fs.readFileSync(marketPath));
  const bankData = JSON.parse(fs.readFileSync(bankPath));
  const files = fs.readdirSync("./users");
  let playersMoney = 0, playersBank = 0;
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(`./users/${file}`));
    playersMoney += data.balance || 0;
    playersBank += data.bank || 0;
  }
  const playersTotal = playersMoney + playersBank;
  const totalEconomy = playersTotal + bankData.balance + (marketData.totalSupply * marketData.coinValue);
  const values = marketData.history.slice(-30).map(h => h.value);
  if (values.length < 2) return interaction.reply("📉 Dados insuficientes.");
  const highest = Math.max(...values);
  const lowest = Math.min(...values);
  const chartUrl = "https://quickchart.io/chart?c=" + encodeURIComponent(JSON.stringify({
    type: "line", data: { labels: values.map((_,i) => `T${i+1}`), datasets: [{ label: "Valor do Bipo", data: values, borderWidth: 3, fill: true, tension: 0.4 }] }
  }));
  const embed = new EmbedBuilder().setColor("#00FFAA").setTitle("📊 Economia Global Bipo Coins")
    .addFields(
      { name: "💰 Valor do bipo", value: `${marketData.coinValue.toFixed(4)}`, inline: true },
      { name: "📈 Maior", value: `${highest.toFixed(4)}`, inline: true },
      { name: "📉 Menor", value: `${lowest.toFixed(4)}`, inline: true },
      { name: "👛 Carteiras", value: `${playersMoney.toFixed(2)}`, inline: true },
      { name: "🏦 Bancos", value: `${playersBank.toFixed(2)}`, inline: true },
      { name: "🏛 Banco Global", value: `${bankData.balance.toFixed(2)}`, inline: true },
      { name: "🌍 Economia Total", value: `${totalEconomy.toFixed(2)} coins`, inline: false }
    )
    .setImage(chartUrl);
  await interaction.reply({ embeds: [embed] });
}

async function handleBanco(interaction) {
  const bankData = JSON.parse(fs.readFileSync(bankPath));
  const botCoinBalance = await getBotCoinBalance();
  const embed = new EmbedBuilder()
    .setColor("#3498db")
    .setTitle("🏦 Banco Central do Bot")
    .addFields(
      { name: "💰 Cofre Global (Bipo)", value: `${bankData.balance.toFixed(2)} Bipo Coins`, inline: true },
      { name: "💎 Cofre Coin", value: `${botCoinBalance.toFixed(8)} Coins`, inline: true }
    );
  await interaction.reply({ embeds: [embed] });
}

async function handleEmprestimo(interaction, userData) {
  const sub = interaction.options.getSubcommand();
  if (sub === "pegar") {
    const amount = interaction.options.getNumber("valor");
    if (userData.loan) return interaction.reply({ content: "❌ Você já tem empréstimo.", ephemeral: true });
    if (isNaN(amount) || amount <= 0 || amount > MAX_LOAN) return interaction.reply({ content: "❌ Valor inválido.", ephemeral: true });
    await interaction.reply("🏦 Analisando crédito...");
    setTimeout(() => {
      userData.balance = truncateBipo(userData.balance + amount);
      userData.loan = { amount };
      saveUser(userData);
      let marketData = JSON.parse(fs.readFileSync(marketPath));
      marketData.totalSupply += amount;
      marketData.coinValue = 1 + (marketData.totalSupply / 10000);
      fs.writeFileSync(marketPath, JSON.stringify(marketData, null, 2));
      interaction.editReply(`✅ Empréstimo aprovado: ${amount}`);
    }, 2000);
  } else if (sub === "pagar") {
    if (!userData.loan) return interaction.reply({ content: "❌ Você não tem dívida.", ephemeral: true });
    const amount = interaction.options.getNumber("valor");
    if (isNaN(amount) || amount <= 0) return interaction.reply({ content: "❌ Valor inválido.", ephemeral: true });
    if (amount > userData.balance) return interaction.reply({ content: "❌ Saldo insuficiente.", ephemeral: true });
    userData.balance = truncateBipo(userData.balance - amount);
    userData.loan.amount -= amount;
    if (userData.loan.amount <= 0) userData.loan = null;
    saveUser(userData);
    await interaction.reply("💳 Pagamento realizado.");
  } else if (sub === "status") {
    if (!userData.loan) return interaction.reply({ content: "💳 Nenhuma dívida ativa.", ephemeral: true });
    const total = Math.floor(userData.loan.amount * (1 + INTEREST_RATE));
    await interaction.reply(`💳 Dívida atual: ${total}`);
  }
}

async function handleMercado(interaction) {
  if (market.length === 0) return interaction.reply("🏪 Mercado vazio.");
  const embed = new EmbedBuilder().setColor("#3498db").setTitle("🏪 Mercado de Minérios").setTimestamp();
  market.forEach(item => {
    embed.addFields({ name: `ID ${item.id} • ${item.ore}`, value: `📦 ${item.amount} | 💰 ${item.price} coins | 👤 <@${item.seller}>`, inline: true });
  });
  await interaction.reply({ embeds: [embed] });
}

async function handleVender(interaction, userData) {
  const ore = interaction.options.getString("minerio");
  const amount = interaction.options.getNumber("quantidade");
  const price = interaction.options.getNumber("preco");
  if (!ore || !amount || !price) return interaction.reply({ content: "Uso: **/vender minerio quantidade preco**", ephemeral: true });
  if (!userData.ores || (userData.ores[ore] || 0) < amount) return interaction.reply({ content: "❌ Minério insuficiente.", ephemeral: true });
  userData.ores[ore] -= amount;
  market.push({ id: marketId++, ore, amount, price, seller: interaction.user.id });
  saveUser(userData);
  await interaction.reply(`🏪 Você colocou **${amount} ${ore}** à venda por **${price} coins**`);
}

async function handleComprarItem(interaction, userData) {
  const id = interaction.options.getInteger("id");
  const item = market.find(x => x.id === id);
  if (!item) return interaction.reply({ content: "❌ Item não encontrado.", ephemeral: true });
  if (userData.balance < item.price) return interaction.reply({ content: "❌ Saldo insuficiente.", ephemeral: true });
  userData.balance = truncateBipo(userData.balance - item.price);
  if (!userData.ores) userData.ores = {};
  userData.ores[item.ore] = (userData.ores[item.ore] || 0) + item.amount;
  const sellerData = loadUser(item.seller);
  sellerData.balance = truncateBipo(sellerData.balance + item.price);
  saveUser(userData);
  saveUser(sellerData);
  const index = market.indexOf(item);
  market.splice(index, 1);
  await interaction.reply(`🛒 Você comprou **${item.amount} ${item.ore}**`);
}

async function handlePicaretas(interaction) {
  const counts = {};
  const files = fs.readdirSync("./users");
  for (const file of files) {
    const p = JSON.parse(fs.readFileSync(`./users/${file}`)).pickaxe || "wood";
    counts[p] = (counts[p] || 0) + 1;
  }
  const ranking = Object.entries(pickaxes).sort((a,b) => b[1].max - a[1].max).slice(0,10);
  const embed = new EmbedBuilder().setColor("#f1c40f").setTitle("⛏ Ranking das Melhores Picaretas");
  ranking.forEach(([key, p], i) => {
    embed.addFields({ name: `#${i+1} ${p.name}`, value: `💰 Ganho: ${p.min}-${p.max}\n🍀 Sorte: ${p.luck}\n🛠 Durabilidade: ${p.durability}\n👥 Jogadores: ${counts[key] || 0}`, inline: true });
  });
  await interaction.reply({ embeds: [embed] });
}

async function handleEncantar(interaction, userData) {
  const price = 8;
  if (userData.balance < price) return interaction.reply({ content: "❌ Você precisa de **8 coins** para girar encantamentos.", ephemeral: true });
  userData.balance = truncateBipo(userData.balance - price);
  const enchants = [
    { name:"⛏ Minerador", rarity:"⚪ Comum", chance:5000, desc:"+1% minérios" },
    { name:"🪨 Quebra Pedra", rarity:"⚪ Comum", chance:5000, desc:"+1 durabilidade" },
    { name:"⚡ Pico Rápido", rarity:"⚪ Comum", chance:5000, desc:"+1% velocidade" },
    { name:"🟢 Veio Rico", rarity:"🟢 Incomum", chance:2000, desc:"+3% minérios" },
    { name:"🔵 Detector de Veios", rarity:"🔵 Raro", chance:700, desc:"+8% minérios" },
    { name:"🟣 Mestre da Mina", rarity:"🟣 Épico", chance:200, desc:"+20% minérios" },
    { name:"🟡 Toque de Ouro", rarity:"🟡 Lendário", chance:60, desc:"+40% ouro" },
    { name:"🔴 Coração da Terra", rarity:"🔴 Mítico", chance:15, desc:"+70% minérios" },
    { name:"🌈 Prisma Mineral", rarity:"🌈 Cromático", chance:3, desc:"+120% minérios" },
    { name:"🕳 Pico dos Deuses", rarity:"🕳 Secret", chance:1, desc:"+300% mineração" }
  ];
  const total = enchants.reduce((a,b)=>a+b.chance,0);
  let rand = Math.random()*total;
  let result;
  for (let e of enchants){
    if (rand < e.chance){ result=e; break; }
    rand -= e.chance;
  }
  await interaction.reply("🎰 Girando encantamentos...");
  setTimeout(async () => {
    if (!userData.enchants) userData.enchants = [];
    userData.enchants.push(result);
    saveUser(userData);
    await interaction.editReply(`✨ **ENCANTAMENTO OBTIDO**\n${result.name}\n${result.rarity}\n📜 ${result.desc}`);
  }, 4500);
}

async function handleEncantamentos(interaction) {
  await interaction.reply(`📜 **ENCANTAMENTOS DAS PICARETAS**\n⚪ COMUM: +1% minérios, +1 durabilidade\n🟢 INCOMUM: +3% minérios\n🔵 RARO: +8% minérios\n🟣 ÉPICO: +20% minérios\n🟡 LENDÁRIO: +40% ouro\n🔴 MÍTICO: +70% mineração\n🌈 CROMÁTICO: +120% mineração\n🕳 SECRET: +300% mineração`);
}

async function handleAjuda(interaction) {
  const economiaEmbed = new EmbedBuilder().setColor("#00BFFF").setTitle("💰 Economia Global").setDescription("🌍 Sistema econômico do servidor").addFields(
    { name: "💳 Saldo", value: "`/saldo`", inline: true },
    { name: "🎁 Daily", value: "`/daily`", inline: true },
    { name: "🏆 Ranking", value: "`/ranking`", inline: true },
    { name: "📊 Gráfico", value: "`/grafico`", inline: true },
    { name: "🏦 Banco", value: "`/banco`", inline: true },
    { name: "💸 Pix", value: "`/pix usuario valor`", inline: true }
  );
  const bancoEmbed = new EmbedBuilder().setColor("#2ecc71").setTitle("🏦 Sistema Bancário").addFields(
    { name: "💰 Empréstimo", value: "`/emprestimo pegar valor`", inline: true },
    { name: "💳 Pagar", value: "`/emprestimo pagar valor`", inline: true },
    { name: "📄 Status", value: "`/emprestimo status`", inline: true }
  );
  const mineracaoEmbed = new EmbedBuilder().setColor("#f1c40f").setTitle("⛏ Mineração").addFields(
    { name: "⛏ Minerar", value: "`/minerar`", inline: true },
    { name: "🛒 Loja", value: "`/loja`", inline: true },
    { name: "⚒ Craft", value: "`/craft tipo`", inline: true },
    { name: "🎒 Inventário", value: "`/inventario`", inline: true }
  );
  const raidEmbed = new EmbedBuilder().setColor("#e74c3c").setTitle("💣 Raids").addFields(
    { name: "🕳 Cave", value: "`/raid cave`", inline: true },
    { name: "⛏ Mine", value: "`/raid mine`", inline: true },
    { name: "💎 Crystal", value: "`/raid crystal`", inline: true },
    { name: "🌑 Abyss", value: "`/raid abyss`", inline: true },
    { name: "🔥 Core", value: "`/raid core`", inline: true }
  );
  const cambioEmbed = new EmbedBuilder().setColor("#9b59b6").setTitle("💱 Câmbio").addFields(
    { name: "🔄 Bipo → Coin", value: "`/converter de:bipo para:coin quantia`", inline: true },
    { name: "🔄 Coin → Bipo", value: "`/converter de:coin para:bipo quantia`", inline: true },
    { name: "💳 Card Bipo", value: "`/bipo_card` (DM)", inline: true },
    { name: "🪙 Card Coin", value: "`/coincard` (DM)", inline: true }
  );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("help_economia").setLabel("💰 Economia").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("help_banco").setLabel("🏦 Banco").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("help_mineracao").setLabel("⛏ Mineração").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("help_raid").setLabel("💣 Raids").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("help_cambio").setLabel("💱 Câmbio").setStyle(ButtonStyle.Primary)
  );
  const msg = await interaction.reply({ embeds: [economiaEmbed], components: [row] });
  const collector = msg.createMessageComponentCollector({ time: 180000 });
  collector.on("collect", async (btnInteraction) => {
    if (btnInteraction.user.id !== interaction.user.id) return btnInteraction.reply({ content: "❌ Apenas quem abriu pode usar.", ephemeral: true });
    if (btnInteraction.customId === "help_economia") btnInteraction.update({ embeds: [economiaEmbed] });
    if (btnInteraction.customId === "help_banco") btnInteraction.update({ embeds: [bancoEmbed] });
    if (btnInteraction.customId === "help_mineracao") btnInteraction.update({ embeds: [mineracaoEmbed] });
    if (btnInteraction.customId === "help_raid") btnInteraction.update({ embeds: [raidEmbed] });
    if (btnInteraction.customId === "help_cambio") btnInteraction.update({ embeds: [cambioEmbed] });
  });
  collector.on("end", () => {
    const disabledRow = new ActionRowBuilder().addComponents(row.components.map(btn => ButtonBuilder.from(btn).setDisabled(true)));
    msg.edit({ components: [disabledRow] });
  });
}

async function handleCoinCard(interaction, userData) {
  const newCard = interaction.options.getString("codigo");
  if (!newCard) {
    return interaction.reply(`💰 Seu card Coin atual: ${maskCard(userData.coinCard)}\nUse \`/coincard codigo:<código>\` para definir.`);
  }
  userData.coinCard = newCard;
  saveUser(userData);
  await interaction.reply(`✅ Card Coin definido com sucesso!`);
}

async function handleBipoCard(interaction, userData) {
  const code = getOrCreateBipoCard(interaction.user.id);
  await interaction.reply(`💳 Seu card Bipo: \`${code}\``);
}

async function handleBipoCardReset(interaction, userData) {
  const newCode = resetBipoCard(interaction.user.id);
  await interaction.reply(`🔁 Seu novo card Bipo: \`${newCode}\``);
}

async function handleConverter(interaction, userData) {
  const fromType = interaction.options.getString("de");
  const toType = interaction.options.getString("para");
  const amount = interaction.options.getNumber("quantia");
  if (!fromType || !toType || isNaN(amount) || amount <= 0) {
    return interaction.reply({ content: "❌ Parâmetros inválidos.", ephemeral: true });
  }

  const feeMultiplier = 1 - (CONVERSION_FEE_PERCENT / 100);

  if (fromType === "bipo" && toType === "coin") {
    if (userData.balance < amount) {
      return interaction.reply({ content: `❌ Você tem apenas ${userData.balance.toFixed(2)} Bipo.`, ephemeral: true });
    }
    if (!userData.coinCard) {
      return interaction.reply({ content: "❌ Defina seu card Coin com `/coincard` no DM.", ephemeral: true });
    }

    const botCoinBalance = await getBotCoinBalance();
    const coinsToSend = truncateCoin(amount * BIPO_TO_COIN_RATE * feeMultiplier);
    if (botCoinBalance < coinsToSend) {
      return interaction.reply({ content: `❌ O bot não tem saldo Coin suficiente para esta conversão (necessário ${coinsToSend.toFixed(8)}, disponível ${botCoinBalance.toFixed(8)}).`, ephemeral: true });
    }

    const transferResult = await transferCoinsBetweenCards(COIN_BOT_CARD, userData.coinCard, coinsToSend);
    if (!transferResult.success) {
      return interaction.reply({ content: `❌ Falha na transferência de Coins: ${transferResult.error}`, ephemeral: true });
    }

    addBankBalance(amount);
    userData.balance = truncateBipo(userData.balance - amount);
    saveUser(userData);

    const feeAmount = amount * (CONVERSION_FEE_PERCENT / 100);
    await interaction.reply(`💱 Conversão realizada!\n${amount.toFixed(2)} Bipo → ${coinsToSend.toFixed(8)} Coins\nTaxa: ${CONVERSION_FEE_PERCENT}% (${feeAmount.toFixed(2)} Bipo)`);
  } 
  else if (fromType === "coin" && toType === "bipo") {
    if (!userData.coinCard) {
      return interaction.reply({ content: "❌ Defina seu card Coin com `/coincard` no DM.", ephemeral: true });
    }

    const coinInfo = await getCoinCardInfo(userData.coinCard);
    if (!coinInfo?.success) {
      return interaction.reply({ content: "❌ Não foi possível verificar seu saldo de Coins.", ephemeral: true });
    }
    const userCoinBalance = Number(coinInfo.coins);
    if (isNaN(userCoinBalance) || userCoinBalance < amount) {
      return interaction.reply({ content: `❌ Você tem apenas ${userCoinBalance.toFixed(8)} Coins.`, ephemeral: true });
    }

    const bankBipoBalance = getBankBalance();
    const bipoToSend = truncateBipo(amount * COIN_TO_BIPO_RATE * feeMultiplier);
    if (bankBipoBalance < bipoToSend) {
      return interaction.reply({ content: `❌ O banco central não tem saldo Bipo suficiente para esta conversão (necessário ${bipoToSend.toFixed(2)}, disponível ${bankBipoBalance.toFixed(2)}).`, ephemeral: true });
    }

    const transferResult = await transferCoinsBetweenCards(userData.coinCard, COIN_BOT_CARD, amount);
    if (!transferResult.success) {
      return interaction.reply({ content: `❌ Falha na transferência de Coins: ${transferResult.error}`, ephemeral: true });
    }

    subtractBankBalance(bipoToSend);
    userData.balance = truncateBipo(userData.balance + bipoToSend);
    saveUser(userData);

    const feeAmount = amount * (CONVERSION_FEE_PERCENT / 100);
    await interaction.reply(`💱 Conversão realizada!\n${amount.toFixed(8)} Coins → ${bipoToSend.toFixed(2)} Bipo\nTaxa: ${CONVERSION_FEE_PERCENT}% (${feeAmount.toFixed(8)} Coins)`);
  } 
  else {
    await interaction.reply({ content: "❌ Tipos inválidos. Use `bipo` ou `coin`.", ephemeral: true });
  }
}

// ================= AUXILIARY =================
async function getBotCoinBalance() {
  if (!COIN_BOT_CARD) return 0;
  const info = await getCoinCardInfo(COIN_BOT_CARD);
  if (info && info.success) return Number(info.coins);
  return 0;
}

// ================= MESSAGE COMMANDS =================
async function handleMinerarMsg(message, user, userData) {
  const cooldownTime = 600000;
  const key = `${user.id}_minerar`;
  if (userCooldown.has(key)) {
    const timePassed = Date.now() - userCooldown.get(key);
    if (timePassed < cooldownTime) {
      const remaining = Math.ceil((cooldownTime - timePassed) / 1000);
      return message.reply(`⛔ Aguarde **${remaining}s** para minerar novamente.`);
    }
  }
  userCooldown.set(key, Date.now());
  const pickaxe = pickaxes[userData.pickaxe] || pickaxes.wood;
  if (!userData.pickaxeDurability) userData.pickaxeDurability = pickaxe.durability;
  const miningMsg = await message.reply("⛏ Iniciando mineração...");
  const stages = ["⛏ Quebrando pedra...", "🪨 Procurando minerais...", "💎 Analisando veios...", "🔍 Escavando fundo..."];
  let step = 0;
  const animation = setInterval(() => {
    safeEdit(miningMsg, stages[step % stages.length]);
    step++;
  }, 800);
  setTimeout(() => {
    clearInterval(animation);
    let amount = Math.random() * (pickaxe.max - pickaxe.min) + pickaxe.min;
    amount = truncateBipo(amount);
    let eventText = "";
    if (Math.random() * 100 < pickaxe.luck) {
      amount = truncateBipo(amount * 2);
      eventText += "\n🍀 **SORTE! Veio rico encontrado!**";
    }
    const oreFound = getRandomOre();
    if (!userData.ores) userData.ores = {};
    userData.ores[oreFound] = (userData.ores[oreFound] || 0) + 1;
    userData.balance = truncateBipo(userData.balance + amount);
    userData.pickaxeDurability -= 1;
    let breakText = "";
    if (userData.pickaxeDurability <= 0) {
      breakText = `\n💥 Sua picareta ${pickaxe.name} quebrou!`;
      userData.pickaxe = "wood";
      userData.pickaxeDurability = pickaxes.wood.durability;
    }
    saveUser(userData);
    const durabilityPercent = userData.pickaxeDurability / pickaxe.durability;
    const greenBars = Math.round(10 * durabilityPercent);
    const durabilityBar = "🟩".repeat(greenBars) + "⬛".repeat(10 - greenBars);
    const embed = new EmbedBuilder()
      .setColor("#2ecc71")
      .setTitle("⛏ Resultado da Mineração")
      .setDescription(`💰 Você minerou **${amount.toFixed(2)} coins**\n🪨 Encontrou: **${oreFound}**${eventText}${breakText}`)
      .addFields(
        { name: "⛏ Picareta", value: pickaxe.name, inline: true },
        { name: "🔧 Durabilidade", value: `${durabilityBar}\n${userData.pickaxeDurability}`, inline: true },
        { name: "💳 Saldo", value: `${userData.balance.toFixed(2)} coins`, inline: true }
      )
      .setFooter({ text: "Sistema de Mineração Bipo ⛏" })
      .setTimestamp();
    safeEdit(miningMsg, { content: "", embeds: [embed] });
  }, 3500);
}

async function handleLojaMsg(message) {
  const embed = new EmbedBuilder()
    .setColor("#2ecc71")
    .setTitle("🛒 Loja de Picaretas")
    .setDescription(`Use **@${client.user.username} comprar <nome>**`)
    .setThumbnail(client.user.displayAvatarURL());
  Object.entries(pickaxes).forEach(([id, p]) => {
    const durabilityBars = Math.round(p.durability / 20);
    const bar = "🟩".repeat(Math.min(durabilityBars, 10)) + "⬛".repeat(10 - Math.min(durabilityBars, 10));
    embed.addFields({
      name: `${p.name} (${id})`,
      value: `💰 **Preço:** ${id === "wood" ? 0 : Math.floor(p.durability * 0.5)} coins\n🔧 **Durabilidade:** ${p.durability}\n📊 ${bar}`,
      inline: true
    });
  });
  await message.reply({ embeds: [embed] });
}

async function handleComprarMsg(message, userData, args) {
  const item = args[0];
  if (!item || !pickaxes[item]) return message.reply("❌ Picareta inválida.");
  const price = item === "wood" ? 0 : Math.floor(pickaxes[item].durability * 0.5);
  if (userData.balance < price) return message.reply("❌ Saldo insuficiente.");
  userData.balance = truncateBipo(userData.balance - price);
  userData.pickaxe = item;
  userData.pickaxeDurability = pickaxes[item].durability;
  saveUser(userData);
  await message.reply(`✅ Você comprou ${pickaxes[item].name}!`);
}

async function handleCraftMsg(message, userData, args) {
  const recipes = {
    iron: { name: "⛓ Picareta de Ferro", cost: { "⛓ Ferro": 5, "🪨 Pedra": 10 } },
    silver: { name: "🥈 Picareta de Prata", cost: { "🥈 Prata": 6, "⛓ Ferro": 3 } },
    gold: { name: "🥇 Picareta de Ouro", cost: { "🥇 Ouro": 6, "🥈 Prata": 4 } },
    platinum: { name: "⚙ Picareta de Platina", cost: { "⚙ Platina": 5, "🥇 Ouro": 3 } },
    ruby: { name: "🔴 Picareta de Rubi", cost: { "🔴 Rubi": 4, "⚙ Platina": 3 } },
    sapphire: { name: "🔵 Picareta de Safira", cost: { "🔵 Safira": 4, "⚙ Platina": 3 } },
    emerald: { name: "🟢 Picareta de Esmeralda", cost: { "🟢 Esmeralda": 4, "🔵 Safira": 2 } },
    diamond: { name: "💎 Picareta de Diamante", cost: { "💎 Diamante": 4, "🟣 Obsidiana": 2 } },
    mythril: { name: "🔷 Picareta de Mythril", cost: { "🔷 Mythril": 3, "💎 Diamante": 2 } },
    adamantite: { name: "🟡 Picareta de Adamantita", cost: { "🟡 Adamantita": 4, "🔷 Mythril": 2 } },
    netherite: { name: "🔥 Picareta de Netherite", cost: { "🔥 Netherite": 2, "🟡 Adamantita": 2 } },
    orichalcum: { name: "☀️ Picareta de Oricalco", cost: { "☀️ Oricalco": 2, "🔥 Netherite": 2 } },
    ether: { name: "🌌 Picareta de Éter", cost: { "🌌 Éter": 1, "☀️ Oricalco": 2 } }
  };
  const type = args[0];
  if (!type) {
    const embed = new EmbedBuilder().setColor("#f39c12").setTitle("⚒ Lista de Picaretas").setDescription("Use **@bot craft <nome>**");
    Object.entries(recipes).forEach(([id, recipe]) => {
      let costText = "";
      for (const ore in recipe.cost) costText += `${ore} x${recipe.cost[ore]}\n`;
      embed.addFields({ name: `${recipe.name} (${id})`, value: costText, inline: true });
    });
    return message.reply({ embeds: [embed] });
  }
  const recipe = recipes[type];
  if (!recipe) return message.reply("❌ Picareta inválida.");
  const inventory = userData.ores || {};
  for (const ore in recipe.cost) {
    if ((inventory[ore] || 0) < recipe.cost[ore]) return message.reply(`❌ Você precisa de **${recipe.cost[ore]} ${ore}**`);
  }
  for (const ore in recipe.cost) inventory[ore] -= recipe.cost[ore];
  userData.pickaxe = type;
  saveUser(userData);
  const embed = new EmbedBuilder().setColor("#2ecc71").setTitle("⚒ Craft realizado!").setDescription(`Você criou **${recipe.name}**`);
  await message.reply({ embeds: [embed] });
}

async function handleRaidMsg(message, userData, args) {
  const RAIDS = {
    cave: { name: "🕳 Caverna Abandonada", price: 3, time: 30000, ores: 6 },
    mine: { name: "⛏ Mina Profunda", price: 5, time: 60000, ores: 10 },
    crystal: { name: "💎 Templo de Cristal", price: 7, time: 90000, ores: 14 },
    abyss: { name: "🌑 Abismo Antigo", price: 10, time: 120000, ores: 18 },
    core: { name: "🔥 Núcleo da Terra", price: 20, time: 180000, ores: 25 }
  };
  const type = args[0];
  const raid = RAIDS[type];
  if (!raid) return message.reply("Raids: cave, mine, crystal, abyss, core");
  if (userData.balance < raid.price) return message.reply("❌ Coins insuficientes.");
  userData.balance = truncateBipo(userData.balance - raid.price);
  const pickaxe = pickaxes[userData.pickaxe] || pickaxes.wood;
  if (!userData.pickaxeDurability) userData.pickaxeDurability = pickaxe.durability;
  const raidMsg = await message.reply(`🚪 Entrando na raid ${raid.name}...`);
  setTimeout(async () => {
    let mined = [];
    let inventory = userData.ores || {};
    for (let i = 0; i < raid.ores; i++) {
      const ore = getRandomOre();
      inventory[ore] = (inventory[ore] || 0) + 1;
      mined.push(ore);
      userData.pickaxeDurability -= 1;
    }
    userData.ores = inventory;
    let broken = false;
    if (userData.pickaxeDurability <= 0) {
      broken = true;
      userData.pickaxe = "wood";
      userData.pickaxeDurability = pickaxes.wood.durability;
    }
    saveUser(userData);
    await safeEdit(raidMsg, `🏆 **RAID CONCLUÍDA**\n🪨 Minérios obtidos: ${mined.join(" ")}\n⛏ Durabilidade restante: ${userData.pickaxeDurability}/${pickaxe.durability}\n${broken ? "💥 Sua picareta quebrou!" : ""}`);
  }, raid.time);
}

async function handlePixMsg(message, userData, args) {
  const target = message.mentions.users.filter(u => u.id !== client.user.id).first();
  const amount = parseFloat(args[1]);
  if (!target || target.bot || target.id === message.author.id) return message.reply("❌ Use: `@bot pix @usuario valor`");
  if (isNaN(amount) || amount <= 0 || amount > 100000000) return message.reply("❌ Valor inválido.");
  createUser(target);
  let targetData = loadUser(target.id);
  if (userData.balance < amount) return message.reply("❌ Saldo insuficiente.");
  const TAX_RATE = 0.02;
  const tax = truncateBipo(amount * TAX_RATE);
  const finalAmount = truncateBipo(amount - tax);
  const confirmEmbed = new EmbedBuilder()
    .setColor("#00ff99")
    .setTitle("💸 CONFIRMAR TRANSFERÊNCIA")
    .setDescription("Digite **sim** para confirmar ou **cancelar**")
    .addFields(
      { name: "👤 Destinatário", value: target.username, inline: true },
      { name: "💰 Valor", value: `${amount.toFixed(2)} coins`, inline: true },
      { name: "🏦 Taxa", value: `${tax.toFixed(2)} coins`, inline: true }
    );
  await message.reply({ embeds: [confirmEmbed] });
  const filter = m => m.author.id === message.author.id && ["sim", "cancelar"].includes(m.content.toLowerCase());
  const collector = message.channel.createMessageCollector({ filter, time: 15000, max: 1 });
  collector.on("collect", async (msg) => {
    if (msg.content.toLowerCase() === "cancelar") return message.reply("❌ Transferência cancelada.");
    const loading = await message.reply("💸 Processando.");
    setTimeout(() => {
      let bank = JSON.parse(fs.readFileSync(bankPath));
      userData.balance = truncateBipo(userData.balance - amount);
      targetData.balance = truncateBipo(targetData.balance + finalAmount);
      bank.balance = truncateBipo(bank.balance + tax);
      saveUser(userData);
      saveUser(targetData);
      fs.writeFileSync(bankPath, JSON.stringify(bank, null, 2));
      loading.edit("✅ PIX realizado com sucesso!");
    }, 2500);
  });
  collector.on("end", collected => { if (collected.size === 0) message.reply("⏳ Tempo esgotado."); });
}

async function handleRankingMsg(message) {
  const loadRanking = () => {
    const files = fs.readdirSync("./users");
    let ranking = [];
    files.forEach(file => {
      const data = JSON.parse(fs.readFileSync(`./users/${file}`));
      ranking.push({ username: data.username, balance: data.balance || 0, bank: data.bank || 0, total: (data.balance || 0) + (data.bank || 0) });
    });
    ranking.sort((a,b) => b.total - a.total);
    return ranking;
  };
  let ranking = loadRanking();
  const generateEmbed = (type) => {
    let sorted;
    if (type === "bank") sorted = [...ranking].sort((a,b) => b.bank - a.bank);
    else if (type === "mineracao") sorted = [...ranking].sort((a,b) => b.balance - a.balance);
    else sorted = [...ranking];
    const embed = new EmbedBuilder().setColor("#8A2BE2").setTitle("🏆 Ranking Bipo Coins").setDescription(`Categoria: **${type}**`);
    sorted.slice(0,10).forEach((u,i) => {
      let medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "👑";
      embed.addFields({ name: `#${i+1} ${medal} ${u.username}`, value: `💰 ${u.total.toFixed(2)} coins` });
    });
    return embed;
  };
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("rank_global").setLabel("🌍 Global").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("rank_bank").setLabel("🏦 Banco").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rank_mineracao").setLabel("⛏ Mineração").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("rank_refresh").setLabel("🔄 Atualizar").setStyle(ButtonStyle.Danger)
  );
  const msg = await message.reply({ embeds: [generateEmbed("global")], components: [row] });
  const collector = msg.createMessageComponentCollector({ time: 60000 });
  collector.on("collect", async (btnInteraction) => {
    if (btnInteraction.user.id !== message.author.id) return btnInteraction.reply({ content: "❌ Apenas quem abriu pode usar.", ephemeral: true });
    if (btnInteraction.customId === "rank_refresh") ranking = loadRanking();
    let embed;
    if (btnInteraction.customId === "rank_global") embed = generateEmbed("global");
    else if (btnInteraction.customId === "rank_bank") embed = generateEmbed("bank");
    else if (btnInteraction.customId === "rank_mineracao") embed = generateEmbed("mineracao");
    else embed = generateEmbed("global");
    btnInteraction.update({ embeds: [embed], components: [row] });
  });
}

async function handleInventarioMsg(message, userData) {
  const inventory = userData.ores || {};
  const oresList = Object.entries(inventory);
  if (oresList.length === 0) return message.reply("🎒 Inventário vazio.");
  const embed = new EmbedBuilder().setColor("#8e44ad").setTitle(`🎒 Inventário de ${message.author.username}`).setDescription("Minérios coletados").setTimestamp();
  oresList.forEach(([ore, amount]) => embed.addFields({ name: ore, value: `Quantidade: **${amount}**`, inline: true }));
  await message.reply({ embeds: [embed] });
}

async function handleGraficoMsg(message) {
  const marketData = JSON.parse(fs.readFileSync(marketPath));
  const bankData = JSON.parse(fs.readFileSync(bankPath));
  const files = fs.readdirSync("./users");
  let playersMoney = 0, playersBank = 0;
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(`./users/${file}`));
    playersMoney += data.balance || 0;
    playersBank += data.bank || 0;
  }
  const playersTotal = playersMoney + playersBank;
  const totalEconomy = playersTotal + bankData.balance + (marketData.totalSupply * marketData.coinValue);
  const values = marketData.history.slice(-30).map(h => h.value);
  if (values.length < 2) return message.reply("📉 Dados insuficientes.");
  const highest = Math.max(...values);
  const lowest = Math.min(...values);
  const chartUrl = "https://quickchart.io/chart?c=" + encodeURIComponent(JSON.stringify({
    type: "line", data: { labels: values.map((_,i) => `T${i+1}`), datasets: [{ label: "Valor do Bipo", data: values, borderWidth: 3, fill: true, tension: 0.4 }] }
  }));
  const embed = new EmbedBuilder().setColor("#00FFAA").setTitle("📊 Economia Global Bipo Coins")
    .addFields(
      { name: "💰 Valor do bipo", value: `${marketData.coinValue.toFixed(4)}`, inline: true },
      { name: "📈 Maior", value: `${highest.toFixed(4)}`, inline: true },
      { name: "📉 Menor", value: `${lowest.toFixed(4)}`, inline: true },
      { name: "👛 Carteiras", value: `${playersMoney.toFixed(2)}`, inline: true },
      { name: "🏦 Bancos", value: `${playersBank.toFixed(2)}`, inline: true },
      { name: "🏛 Banco Global", value: `${bankData.balance.toFixed(2)}`, inline: true },
      { name: "🌍 Economia Total", value: `${totalEconomy.toFixed(2)} coins`, inline: false }
    )
    .setImage(chartUrl);
  await message.reply({ embeds: [embed] });
}

async function handleBancoMsg(message) {
  const bankData = JSON.parse(fs.readFileSync(bankPath));
  const botCoinBalance = await getBotCoinBalance();
  const embed = new EmbedBuilder()
    .setColor("#3498db")
    .setTitle("🏦 Banco Central do Bot")
    .addFields(
      { name: "💰 Cofre Global (Bipo)", value: `${bankData.balance.toFixed(2)} Bipo Coins`, inline: true },
      { name: "💎 Cofre Coin", value: `${botCoinBalance.toFixed(8)} Coins`, inline: true }
    );
  await message.reply({ embeds: [embed] });
}

async function handleEmprestimoMsg(message, userData, args) {
  const sub = args[0];
  if (sub === "pegar") {
    const amount = parseInt(args[1]);
    if (userData.loan) return message.reply("❌ Você já tem empréstimo.");
    if (isNaN(amount) || amount <= 0 || amount > MAX_LOAN) return message.reply("❌ Valor inválido.");
    const msg = await message.reply("🏦 Analisando crédito...");
    setTimeout(() => {
      userData.balance = truncateBipo(userData.balance + amount);
      userData.loan = { amount };
      saveUser(userData);
      let marketData = JSON.parse(fs.readFileSync(marketPath));
      marketData.totalSupply += amount;
      marketData.coinValue = 1 + (marketData.totalSupply / 10000);
      fs.writeFileSync(marketPath, JSON.stringify(marketData, null, 2));
      msg.edit(`✅ Empréstimo aprovado: ${amount}`);
    }, 2000);
  } else if (sub === "pagar") {
    if (!userData.loan) return message.reply("❌ Você não tem dívida.");
    const amount = parseInt(args[1]);
    if (isNaN(amount) || amount <= 0) return message.reply("❌ Valor inválido.");
    if (amount > userData.balance) return message.reply("❌ Saldo insuficiente.");
    userData.balance = truncateBipo(userData.balance - amount);
    userData.loan.amount -= amount;
    if (userData.loan.amount <= 0) userData.loan = null;
    saveUser(userData);
    await message.reply("💳 Pagamento realizado.");
  } else if (sub === "status") {
    if (!userData.loan) return message.reply("💳 Nenhuma dívida ativa.");
    const total = Math.floor(userData.loan.amount * (1 + INTEREST_RATE));
    await message.reply(`💳 Dívida atual: ${total}`);
  } else {
    await message.reply("Use: emprestimo pegar|pagar|status <valor>");
  }
}

async function handleMercadoMsg(message) {
  if (market.length === 0) return message.reply("🏪 Mercado vazio.");
  const embed = new EmbedBuilder().setColor("#3498db").setTitle("🏪 Mercado de Minérios").setTimestamp();
  market.forEach(item => {
    embed.addFields({ name: `ID ${item.id} • ${item.ore}`, value: `📦 ${item.amount} | 💰 ${item.price} coins | 👤 <@${item.seller}>`, inline: true });
  });
  await message.reply({ embeds: [embed] });
}

async function handleVenderMsg(message, userData, args) {
  const ore = args[0];
  const amount = Number(args[1]);
  const price = Number(args[2]);
  if (!ore || !amount || !price) return message.reply("Uso: **vender <minerio> <quantidade> <preço>**");
  if (!userData.ores || (userData.ores[ore] || 0) < amount) return message.reply("❌ Minério insuficiente.");
  userData.ores[ore] -= amount;
  market.push({ id: marketId++, ore, amount, price, seller: message.author.id });
  saveUser(userData);
  await message.reply(`🏪 Você colocou **${amount} ${ore}** à venda por **${price} coins**`);
}

async function handleComprarItemMsg(message, userData, args) {
  const id = Number(args[0]);
  const item = market.find(x => x.id === id);
  if (!item) return message.reply("❌ Item não encontrado.");
  if (userData.balance < item.price) return message.reply("❌ Saldo insuficiente.");
  userData.balance = truncateBipo(userData.balance - item.price);
  if (!userData.ores) userData.ores = {};
  userData.ores[item.ore] = (userData.ores[item.ore] || 0) + item.amount;
  const sellerData = loadUser(item.seller);
  sellerData.balance = truncateBipo(sellerData.balance + item.price);
  saveUser(userData);
  saveUser(sellerData);
  const index = market.indexOf(item);
  market.splice(index, 1);
  await message.reply(`🛒 Você comprou **${item.amount} ${item.ore}**`);
}

async function handlePicaretasMsg(message) {
  const counts = {};
  const files = fs.readdirSync("./users");
  for (const file of files) {
    const p = JSON.parse(fs.readFileSync(`./users/${file}`)).pickaxe || "wood";
    counts[p] = (counts[p] || 0) + 1;
  }
  const ranking = Object.entries(pickaxes).sort((a,b) => b[1].max - a[1].max).slice(0,10);
  const embed = new EmbedBuilder().setColor("#f1c40f").setTitle("⛏ Ranking das Melhores Picaretas");
  ranking.forEach(([key, p], i) => {
    embed.addFields({ name: `#${i+1} ${p.name}`, value: `💰 Ganho: ${p.min}-${p.max}\n🍀 Sorte: ${p.luck}\n🛠 Durabilidade: ${p.durability}\n👥 Jogadores: ${counts[key] || 0}`, inline: true });
  });
  await message.reply({ embeds: [embed] });
}

async function handleEncantarMsg(message, userData) {
  const price = 8;
  if (userData.balance < price) return message.reply("❌ Você precisa de **8 coins** para girar encantamentos.");
  userData.balance = truncateBipo(userData.balance - price);
  const enchants = [
    { name:"⛏ Minerador", rarity:"⚪ Comum", chance:5000, desc:"+1% minérios" },
    { name:"🪨 Quebra Pedra", rarity:"⚪ Comum", chance:5000, desc:"+1 durabilidade" },
    { name:"⚡ Pico Rápido", rarity:"⚪ Comum", chance:5000, desc:"+1% velocidade" },
    { name:"🟢 Veio Rico", rarity:"🟢 Incomum", chance:2000, desc:"+3% minérios" },
    { name:"🔵 Detector de Veios", rarity:"🔵 Raro", chance:700, desc:"+8% minérios" },
    { name:"🟣 Mestre da Mina", rarity:"🟣 Épico", chance:200, desc:"+20% minérios" },
    { name:"🟡 Toque de Ouro", rarity:"🟡 Lendário", chance:60, desc:"+40% ouro" },
    { name:"🔴 Coração da Terra", rarity:"🔴 Mítico", chance:15, desc:"+70% minérios" },
    { name:"🌈 Prisma Mineral", rarity:"🌈 Cromático", chance:3, desc:"+120% minérios" },
    { name:"🕳 Pico dos Deuses", rarity:"🕳 Secret", chance:1, desc:"+300% mineração" }
  ];
  const total = enchants.reduce((a,b)=>a+b.chance,0);
  let rand = Math.random()*total;
  let result;
  for (let e of enchants){
    if (rand < e.chance){ result=e; break; }
    rand -= e.chance;
  }
  const spinMsg = await message.reply("🎰 Girando encantamentos...");
  setTimeout(() => safeEdit(spinMsg, "✨ Energia mágica envolvendo sua picareta..."), 1500);
  setTimeout(() => safeEdit(spinMsg, "💎 Cristais mágicos aparecem..."), 3000);
  setTimeout(() => {
    if (!userData.enchants) userData.enchants = [];
    userData.enchants.push(result);
    saveUser(userData);
    safeEdit(spinMsg, `✨ **ENCANTAMENTO OBTIDO**\n${result.name}\n${result.rarity}\n📜 ${result.desc}`);
  }, 4500);
}

async function handleEncantamentosMsg(message) {
  await message.reply(`📜 **ENCANTAMENTOS DAS PICARETAS**\n⚪ COMUM: +1% minérios, +1 durabilidade\n🟢 INCOMUM: +3% minérios\n🔵 RARO: +8% minérios\n🟣 ÉPICO: +20% minérios\n🟡 LENDÁRIO: +40% ouro\n🔴 MÍTICO: +70% mineração\n🌈 CROMÁTICO: +120% mineração\n🕳 SECRET: +300% mineração`);
}

async function handleAjudaMsg(message) {
  const economiaEmbed = new EmbedBuilder().setColor("#00BFFF").setTitle("💰 Economia Global").setDescription("🌍 Sistema econômico do servidor").addFields(
    { name: "💳 Saldo", value: "`saldo`", inline: true },
    { name: "🎁 Daily", value: "`daily`", inline: true },
    { name: "🏆 Ranking", value: "`ranking`", inline: true },
    { name: "📊 Gráfico", value: "`grafico`", inline: true },
    { name: "🏦 Banco", value: "`banco`", inline: true },
    { name: "💸 Pix", value: "`pix @user valor`", inline: true }
  );
  const bancoEmbed = new EmbedBuilder().setColor("#2ecc71").setTitle("🏦 Sistema Bancário").addFields(
    { name: "💰 Empréstimo", value: "`emprestimo pegar <valor>`", inline: true },
    { name: "💳 Pagar", value: "`emprestimo pagar <valor>`", inline: true },
    { name: "📄 Status", value: "`emprestimo status`", inline: true }
  );
  const mineracaoEmbed = new EmbedBuilder().setColor("#f1c40f").setTitle("⛏ Mineração").addFields(
    { name: "⛏ Minerar", value: "`minerar`", inline: true },
    { name: "🛒 Loja", value: "`loja`", inline: true },
    { name: "⚒ Craft", value: "`craft <picareta>`", inline: true },
    { name: "🎒 Inventário", value: "`inventario`", inline: true }
  );
  const raidEmbed = new EmbedBuilder().setColor("#e74c3c").setTitle("💣 Raids").addFields(
    { name: "🕳 Cave", value: "`raid cave`", inline: true },
    { name: "⛏ Mine", value: "`raid mine`", inline: true },
    { name: "💎 Crystal", value: "`raid crystal`", inline: true },
    { name: "🌑 Abyss", value: "`raid abyss`", inline: true },
    { name: "🔥 Core", value: "`raid core`", inline: true }
  );
  const cambioEmbed = new EmbedBuilder().setColor("#9b59b6").setTitle("💱 Câmbio").addFields(
    { name: "🔄 Bipo → Coin", value: "`converter bipo coin <valor>`", inline: true },
    { name: "🔄 Coin → Bipo", value: "`converter coin bipo <valor>`", inline: true },
    { name: "💳 Card Bipo", value: "`bipo card` (DM)", inline: true },
    { name: "🪙 Card Coin", value: "`coincard` (DM)", inline: true }
  );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("help_economia").setLabel("💰 Economia").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("help_banco").setLabel("🏦 Banco").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("help_mineracao").setLabel("⛏ Mineração").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("help_raid").setLabel("💣 Raids").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("help_cambio").setLabel("💱 Câmbio").setStyle(ButtonStyle.Primary)
  );
  const msg = await message.reply({ embeds: [economiaEmbed], components: [row] });
  const collector = msg.createMessageComponentCollector({ time: 180000 });
  collector.on("collect", async (btnInteraction) => {
    if (btnInteraction.user.id !== message.author.id) return btnInteraction.reply({ content: "❌ Apenas quem abriu pode usar.", ephemeral: true });
    if (btnInteraction.customId === "help_economia") btnInteraction.update({ embeds: [economiaEmbed] });
    if (btnInteraction.customId === "help_banco") btnInteraction.update({ embeds: [bancoEmbed] });
    if (btnInteraction.customId === "help_mineracao") btnInteraction.update({ embeds: [mineracaoEmbed] });
    if (btnInteraction.customId === "help_raid") btnInteraction.update({ embeds: [raidEmbed] });
    if (btnInteraction.customId === "help_cambio") btnInteraction.update({ embeds: [cambioEmbed] });
  });
  collector.on("end", () => {
    const disabledRow = new ActionRowBuilder().addComponents(row.components.map(btn => ButtonBuilder.from(btn).setDisabled(true)));
    msg.edit({ components: [disabledRow] });
  });
}

async function handleCoinCardMsg(message, userData, args) {
  const newCard = args[0];
  if (!newCard) {
    return message.reply(`💰 Seu card Coin atual: ${maskCard(userData.coinCard)}\nUse \`@${client.user.username} coincard <código>\` para definir.`);
  }
  userData.coinCard = newCard;
  saveUser(userData);
  await message.reply(`✅ Card Coin definido com sucesso!`);
}

async function handleConverterMsg(message, userData, args) {
  const fromType = args[0];
  const toType = args[1];
  const amount = parseFloat(args[2]);
  if (!fromType || !toType || isNaN(amount) || amount <= 0) {
    return message.reply("❌ Uso: `converter bipo coin <quantia>` ou `converter coin bipo <quantia>`");
  }

  const feeMultiplier = 1 - (CONVERSION_FEE_PERCENT / 100);

  if (fromType === "bipo" && toType === "coin") {
    if (userData.balance < amount) return message.reply(`❌ Você tem apenas ${userData.balance.toFixed(2)} Bipo.`);
    if (!userData.coinCard) return message.reply("❌ Defina seu card Coin com `coincard` no DM.");

    const botCoinBalance = await getBotCoinBalance();
    const coinsToSend = truncateCoin(amount * BIPO_TO_COIN_RATE * feeMultiplier);
    if (botCoinBalance < coinsToSend) {
      return message.reply(`❌ O bot não tem saldo Coin suficiente para esta conversão (necessário ${coinsToSend.toFixed(8)}, disponível ${botCoinBalance.toFixed(8)}).`);
    }

    const transferResult = await transferCoinsBetweenCards(COIN_BOT_CARD, userData.coinCard, coinsToSend);
    if (!transferResult.success) return message.reply(`❌ Falha na transferência de Coins: ${transferResult.error}`);

    addBankBalance(amount);
    userData.balance = truncateBipo(userData.balance - amount);
    saveUser(userData);

    const feeAmount = amount * (CONVERSION_FEE_PERCENT / 100);
    await message.reply(`💱 Conversão realizada!\n${amount.toFixed(2)} Bipo → ${coinsToSend.toFixed(8)} Coins\nTaxa: ${CONVERSION_FEE_PERCENT}% (${feeAmount.toFixed(2)} Bipo)`);
  } 
  else if (fromType === "coin" && toType === "bipo") {
    if (!userData.coinCard) return message.reply("❌ Defina seu card Coin com `coincard` no DM.");

    const coinInfo = await getCoinCardInfo(userData.coinCard);
    if (!coinInfo?.success) return message.reply("❌ Não foi possível verificar seu saldo de Coins.");
    const userCoinBalance = Number(coinInfo.coins);
    if (isNaN(userCoinBalance) || userCoinBalance < amount) return message.reply(`❌ Você tem apenas ${userCoinBalance.toFixed(8)} Coins.`);

    const bankBipoBalance = getBankBalance();
    const bipoToSend = truncateBipo(amount * COIN_TO_BIPO_RATE * feeMultiplier);
    if (bankBipoBalance < bipoToSend) {
      return message.reply(`❌ O banco central não tem saldo Bipo suficiente para esta conversão (necessário ${bipoToSend.toFixed(2)}, disponível ${bankBipoBalance.toFixed(2)}).`);
    }

    const transferResult = await transferCoinsBetweenCards(userData.coinCard, COIN_BOT_CARD, amount);
    if (!transferResult.success) return message.reply(`❌ Falha na transferência de Coins: ${transferResult.error}`);

    subtractBankBalance(bipoToSend);
    userData.balance = truncateBipo(userData.balance + bipoToSend);
    saveUser(userData);

    const feeAmount = amount * (CONVERSION_FEE_PERCENT / 100);
    await message.reply(`💱 Conversão realizada!\n${amount.toFixed(8)} Coins → ${bipoToSend.toFixed(2)} Bipo\nTaxa: ${CONVERSION_FEE_PERCENT}% (${feeAmount.toFixed(8)} Coins)`);
  } 
  else {
    await message.reply("❌ Tipos inválidos. Use `bipo coin` ou `coin bipo`.");
  }
}

// ================= MESSAGE CREATE HANDLER =================
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const prefix = `<@${client.user.id}>`;
  const prefix2 = `<@!${client.user.id}>`;
  if (!message.content.startsWith(prefix) && !message.content.startsWith(prefix2)) return;

  const args = message.content
    .replace(prefix, "")
    .replace(prefix2, "")
    .trim()
    .split(/ +/);
  const command = args.shift()?.toLowerCase();
  if (!command) return;

  const user = message.author;
  createUser(user);
  let userData = loadUser(user.id);
  const isDM = message.channel.type === 1;

  try {
    switch (command) {
      case "saldo":
        await handleSaldo(message, user, userData, false);
        break;
      case "daily":
        await handleDaily(message, user, userData, false);
        break;
      case "minerar":
        await handleMinerarMsg(message, user, userData);
        break;
      case "loja":
        await handleLojaMsg(message);
        break;
      case "comprar":
        await handleComprarMsg(message, userData, args);
        break;
      case "craft":
        await handleCraftMsg(message, userData, args);
        break;
      case "raid":
        await handleRaidMsg(message, userData, args);
        break;
      case "pix":
        await handlePixMsg(message, userData, args);
        break;
      case "ranking":
        await handleRankingMsg(message);
        break;
      case "inventario":
        await handleInventarioMsg(message, userData);
        break;
      case "grafico":
        await handleGraficoMsg(message);
        break;
      case "banco":
        await handleBancoMsg(message);
        break;
      case "emprestimo":
        await handleEmprestimoMsg(message, userData, args);
        break;
      case "mercado":
        await handleMercadoMsg(message);
        break;
      case "vender":
        await handleVenderMsg(message, userData, args);
        break;
      case "compraritem":
        await handleComprarItemMsg(message, userData, args);
        break;
      case "picaretas":
        await handlePicaretasMsg(message);
        break;
      case "encantar":
        await handleEncantarMsg(message, userData);
        break;
      case "encantamentos":
        await handleEncantamentosMsg(message);
        break;
      case "ajuda":
        await handleAjudaMsg(message);
        break;
      case "coincard":
        if (!isDM) return message.reply("❌ Use este comando no DM.");
        await handleCoinCardMsg(message, userData, args);
        break;
      case "bipo":
        if (!isDM) return message.reply("❌ Use este comando no DM.");
        if (args[0] === "card") {
          if (args[1] === "reset") {
            const newCode = resetBipoCard(user.id);
            await message.reply(`🔁 Seu novo card Bipo: \`${newCode}\``);
          } else {
            const code = getOrCreateBipoCard(user.id);
            await message.reply(`💳 Seu card Bipo: \`${code}\``);
          }
        } else {
          await message.reply("Use `bipo card` ou `bipo card reset`.");
        }
        break;
      case "converter":
        await handleConverterMsg(message, userData, args);
        break;
      default:
        await message.reply("Comando não reconhecido. Use `@bot ajuda` para ver a lista.");
    }
  } catch (err) {
    console.error(`Erro no comando de mensagem ${command}:`, err);
    await message.reply("❌ Ocorreu um erro interno.");
  }
});

// ================= START BOT =================
client.once("ready", async () => {
  console.log(`🤖 Bot online como ${client.user.tag}`);
  if (!fs.existsSync(bankPath)) {
    fs.writeFileSync(bankPath, JSON.stringify({ balance: 0 }, null, 2));
  }
  fixAllBalances();
  rebuildBipoCardMap();
});

client.login(TOKEN);

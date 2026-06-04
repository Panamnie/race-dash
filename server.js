const express = require("express");
const cors = require("cors");
const EventSource = require("eventsource");

const app = express();
const PORT = process.env.PORT || 3000;

/*
  Główne źródło danych live.
  Zmienione z:
  https://www.gs21.pl/bramka/live_new.php?tid=1

  Na:
  https://gs21.gokartsystem.pl/bramka/live_new.php?tid=1
*/
const SOURCE_URL = "https://gs21.gokartsystem.pl/bramka/live_new.php?tid=1";

/*
  Adres strony referencyjnej.
  Pomaga, gdy serwer GS21 sprawdza nagłówki.
*/
const REFERER_URL = "https://gs21.gokartsystem.pl/pl/api/live_www__tid_1_h_7c7721574e08c7f4878660c0a5f27a5b";

app.use(cors());
app.use(express.static("public"));

let latestRaw = null;
let latestKarts = {};

let connectionStatus = {
  connected: false,
  lastUpdate: null,
  lastMessage: null,
  reconnects: 0,
  error: null
};

function stripTags(value) {
  if (!value) return "";

  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function getClassText(html, className) {
  if (!html) return "";

  const regex = new RegExp(
    `<[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`,
    "i"
  );

  const match = String(html).match(regex);
  if (!match) return "";

  return stripTags(match[1]);
}

function getAllClassText(html, className) {
  if (!html) return [];

  const regex = new RegExp(
    `<[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`,
    "gi"
  );

  const result = [];
  let match;

  while ((match = regex.exec(String(html))) !== null) {
    result.push(stripTags(match[1]));
  }

  return result;
}

function safe(value, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).trim();
}

function parseEntry(html, mode, id, data) {
  const isRace = mode === "r";

  const kart = getClassText(html, "kart");

  const driver = isRace
    ? getClassText(html, "nazwiskor")
    : getClassText(html, "nazwisko");

  const position = getClassText(html, "poz");

  const laps = isRace
    ? getClassText(html, "lapsr")
    : getClassText(html, "laps");

  const bestLap = isRace
    ? getClassText(html, "bestlapr")
    : getClassText(html, "bestlap");

  const lastLap = isRace
    ? getClassText(html, "lastlapr")
    : getClassText(html, "lastlap");

  const diff = isRace
    ? getClassText(html, "dif_sek")
    : getClassText(html, "dif");

  const diffLap = isRace
    ? getClassText(html, "dif_lap")
    : "";

  const sectors = isRace
    ? getAllClassText(html, "sektorr")
    : getAllClassText(html, "sektor");

  const sector1 = data["s1_" + id] || sectors[0] || "";
  const sector2 = data["s2_" + id] || sectors[1] || "";
  const sector3 = data["s3_" + id] || sectors[2] || "";

  let delta = diff || "";

  if (diffLap && diff) {
    delta = `${diffLap} / ${diff}`;
  }

  if (diffLap && !diff) {
    delta = diffLap;
  }

  return {
    id,
    mode: isRace ? "race" : "qualifying",
    kart: safe(kart),
    driver: safe(driver),
    position: safe(position),
    laps: safe(laps),
    lastLap: safe(lastLap),
    bestLap: safe(bestLap),
    sector1: safe(sector1),
    sector2: safe(sector2),
    sector3: safe(sector3),
    delta: safe(delta)
  };
}

function processLiveData(data) {
  const karts = {};

  const preferredPrefixes = data.rodzaj == 1
    ? ["r_data_", "q_data_"]
    : ["q_data_", "r_data_"];

  for (const prefix of preferredPrefixes) {
    for (const key of Object.keys(data)) {
      if (!key.startsWith(prefix)) continue;

      const html = data[key];
      if (!html) continue;

      const id = key.replace(prefix, "");
      const mode = prefix.startsWith("r") ? "r" : "q";

      const entry = parseEntry(html, mode, id, data);

      if (!entry.kart) continue;

      karts[entry.kart] = {
        ...entry,
        trackName: safe(data.tor_nazwa),
        sessionTime: safe(data.czas),
        sessionLap: safe(data.okr),
        flag: data.flaga ?? "",
        modeNumber: data.rodzaj ?? "",
        updatedAt: new Date().toISOString()
      };
    }
  }

  latestRaw = data;
  latestKarts = karts;

  connectionStatus.connected = true;
  connectionStatus.lastUpdate = new Date().toISOString();
  connectionStatus.lastMessage = "Odebrano dane z GS21";
  connectionStatus.error = null;

  console.log(
    "Odebrano dane. Dostępne wózki:",
    Object.keys(latestKarts).join(", ") || "brak"
  );
}

function connectToGs21() {
  console.log("");
  console.log("Łączenie z GS21:", SOURCE_URL);

  const es = new EventSource(SOURCE_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
      "Accept": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Referer": REFERER_URL,
      "Origin": "https://gs21.gokartsystem.pl"
    }
  });

  es.onopen = () => {
    console.log("Połączono z GS21 live.");
    connectionStatus.connected = true;
    connectionStatus.error = null;
    connectionStatus.lastMessage = "Połączono z GS21";
  };

  es.onmessage = (event) => {
    try {
      if (!event.data) return;

      const data = JSON.parse(event.data);
      processLiveData(data);
    } catch (err) {
      console.error("Błąd parsowania danych:", err.message);
      connectionStatus.error = "Błąd parsowania danych: " + err.message;
    }
  };

  es.onerror = (err) => {
    console.error("Błąd połączenia z GS21.");
    console.error("Próba ponownego połączenia za 3 sekundy.");

    connectionStatus.connected = false;
    connectionStatus.error = "Błąd połączenia z GS21";
    connectionStatus.reconnects += 1;

    try {
      es.close();
    } catch (_) {}

    setTimeout(connectToGs21, 500);
  };
}

app.get("/api/status", (req, res) => {
  res.json({
    status: connectionStatus,
    source: SOURCE_URL,
    referer: REFERER_URL,
    kartsAvailable: Object.keys(latestKarts),
    kartsCount: Object.keys(latestKarts).length
  });
});

app.get("/api/live", (req, res) => {
  res.json({
    status: connectionStatus,
    karts: Object.values(latestKarts)
  });
});

app.get("/api/kart/:number", (req, res) => {
  const number = String(req.params.number);
  const kart = latestKarts[number];

  if (!kart) {
    return res.status(404).json({
      error: true,
      message: `Brak danych dla wózka ${number}`,
      kart: number,
      status: connectionStatus,
      availableKarts: Object.keys(latestKarts)
    });
  }

  res.json({
    error: false,
    ...kart
  });
});

app.get("/api/raw", (req, res) => {
  res.json(latestRaw || {});
});

app.get("/api/debug", (req, res) => {
  res.json({
    source: SOURCE_URL,
    referer: REFERER_URL,
    status: connectionStatus,
    latestKarts,
    latestRawKeys: latestRaw ? Object.keys(latestRaw) : []
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("Race Dash działa.");
  console.log(`Lokalnie:  http://localhost:${PORT}`);
  console.log(`Status:    http://localhost:${PORT}/api/status`);
  console.log(`Wózek 5:   http://localhost:${PORT}/api/kart/5`);
  console.log(`Debug:     http://localhost:${PORT}/api/debug`);
  console.log("");
});

connectToGs21();

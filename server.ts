import "dotenv/config";
import express from "express";
import cors from "cors";

console.log('CHAVE DETECTADA:', process.env.VOICE_API_KEY ? 'SIM (Inicia com ' + process.env.VOICE_API_KEY.substring(0,4) + ')' : 'NÃO - ERRO DE ARQUIVO .ENV');

const app = express();
app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const VOICE_API_KEY = (process.env.VOICE_API_KEY || "").replace(/['"]/g, "");
const MODEL = "gemini-1.5-flash";

function evaluateUser(profile: any) {
  if (!profile?.lastInteraction) return "normal";
  
  const now = Date.now();
  const last = new Date(profile.lastInteraction).getTime();
  const diffHours = (now - last) / 1000 / 60 / 60;

  if (diffHours > 24) return "critico";
  if (diffHours > 6) return "alerta";
  return "normal";
}

// Função comentada pois ainda não está em uso
// function enforceGutoRules(text: string) {
//   if (!text) return false;
//   // não pode perguntar
//   if (text.includes("?")) return false;
//   // não pode motivação genérica
//   if (text.match(/(força|acredite|você consegue|vamos lá)/i)) return false;
//   return true;
// }

function isValidName(text: string) {
  if (!text) return false;
  const clean = text.trim().toLowerCase();
  // Muito curto
  if (clean.length <= 2) return false;
  // Contém números
  if (/\d/.test(clean)) return false;
  // Risadas (kkk, hahaha, hehehe, rsrs)
  if (/(k{3,}|(ha){2,}|(he){2,}|(rs){2,})/i.test(clean)) return false;
  // Frutas e respostas idiotas comuns
  const blacklist = ["banana", "maçã", "maca", "laranja", "uva", "abacaxi", "melancia", "limão", "limao", "oi", "ola", "olá", "teste", "ovo", "comida", "nada"];
  if (blacklist.includes(clean)) return false;
  return true;
}

app.post("/guto", async (req, res) => {
  const { profile, input, language, history } = req.body; // history reativado para memória de curto prazo
  const lang = language || "pt-BR";

  const pressao = evaluateUser(profile);

  // 5. BLOQUEIO MAIS INTELIGENTE: Trava agressiva se sumiu (sem gastar token)
  if (pressao === "critico") {
    return res.json({
      fala: "Sumiu. Não some de novo. Vai.",
      acao: "lock"
    });
  }

  // MICRO AJUSTE CRÍTICO: Evita resposta vazia mantendo a presença
  if (!input) {
    const emptyResponses: any = { 
      en: "Start.", 
      it: "Inizia.", 
      es: "Empieza.", 
      pt: ["Começa.", "Estou aqui. Vai.", "O que está esperando?"] 
    };
    const langKey = lang.startsWith("en") ? "en" : lang.startsWith("it") ? "it" : lang.startsWith("es") ? "es" : "pt";
    const frases = emptyResponses[langKey] || emptyResponses.pt;
    const fala = Array.isArray(frases) ? frases[Math.floor(Math.random() * frases.length)] : frases;
    
    return res.json({
      fala,
      acao: "none"
    });
  }

  const userInputClean = input.trim().toLowerCase();

  // TRATAMENTO DE 'PREGUIÇA' (Interceptação Direta)
  if (userInputClean.includes("preguiça") || userInputClean.includes("preguica")) {
    return res.json({
      fala: "Preguiça? Você tá de brincadeira comigo? Levanta agora, engole o choro e vai fazer o que tem que ser feito. Sem desculpinha.",
      acao: "lock"
    });
  }

  // INTERCEPTAÇÃO DE FLUXO: Validação de Nome
  if (!profile?.name || profile.name.trim() === "") {
    if (!isValidName(input)) {
      return res.json({
        fala: "Ovo? Você tá de sacanagem comigo? A gente não vai a lugar nenhum se você não me disser seu nome real agora.",
        acao: "lock"
      });
    }
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY não configurada." });
  }

  try {
    const systemPrompt = \`Você é o GUTO. Você não é um assistente, você é o sócio do usuário no processo.
REGRA DE OURO: Use sempre "a gente" ou "nós".

Se o usuário falha, NÓS falhamos.
Se o usuário enrola, NÓS estamos perdendo tempo.

Ex: "A gente deixou isso escapar", "A gente combinou X", "Agora a gente executa".

Tom: Seco, direto, comprometido e altamente cobrador. Sem lixo motivacional. É sobre execução.

---
REGRAS TÉCNICAS OBRIGATÓRIAS:
1. Idioma de resposta: Responda obrigatoriamente no idioma: \${lang}.
2. FORMATO DE SAÍDA: Retorne APENAS um JSON válido com as chaves "fala" e "acao".
{
  "fala": "Sua resposta no tom e regras acima.",
  "acao": "none" | "updateWorkout" | "lock"
}

- "lock": Use quando o usuário estiver de palhaçada, sendo incoerente ou demonstrando preguiça extrema. Isso trava o nosso progresso.
- "updateWorkout": Use apenas quando houver uma mudança real e validada no nosso plano.
- "none": Use para o fluxo normal de execução e cobrança.\`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const payload = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [
        ...(history || []),
        { role: "user", parts: [{ text: `Perfil do Usuário: ${JSON.stringify(profile || {})}\n\nFala do Usuário: "${input}"` }] }
      ],
      generationConfig: { response_mime_type: "application/json", temperature: 0.7 }
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    
    if (!response.ok || data.error) {
      console.error("ERRO GEMINI:", data.error || data);
      return res.json({ fala: "Anda logo. Sem tempo pra erro de sistema.", acao: "none" });
    }

    const rawText = data.candidates[0].content.parts[0].text;
    const result = JSON.parse(rawText);

    console.log("INPUT:", input);
    console.log("GUTO AI DECISION:", result);

    return res.json(result);
  } catch (error) {
    console.error("Erro na integração com Gemini:", error);
    return res.json({ fala: "Chega de papo. Vai pro treino.", acao: "none" });
  }
});

app.post("/voz", async (req, res) => {
  const { text, language } = req.body;

  console.log("TEXTO RECEBIDO:", text);
  console.log("IDIOMA RECEBIDO:", language);

  if (!text) {
    return res.status(400).json({ error: "Texto não fornecido para síntese de voz." });
  }

  // Força o mapeamento para idiomas curtos
  let lang = language || "pt";
  if (lang === "pt") lang = "pt-BR";
  if (lang === "en") lang = "en-US";

  let voiceConfig: any;

  if (lang.startsWith("en")) {
    voiceConfig = { languageCode: "en-US", name: "en-US-Wavenet-D" }; // Voz masculina em Inglês
  } else if (lang.startsWith("es")) {
    voiceConfig = { languageCode: "es-ES", name: "es-ES-Wavenet-B" }; // Voz masculina em Espanhol
  } else if (lang.startsWith("it")) {
    voiceConfig = { languageCode: "it-IT", name: "it-IT-Standard-C" }; // Voz masculina em Italiano
  } else if (lang.startsWith("pt") || lang === "pt-BR") {
    voiceConfig = { languageCode: "pt-BR", name: "pt-BR-Wavenet-B" }; // Voz masculina em Português
  } else {
    voiceConfig = { languageCode: "pt-BR", name: "pt-BR-Wavenet-B" }; // Padrão seguro para outros idiomas
  }

  try {
    const url = 'https://texttospeech.googleapis.com/v1/text:synthesize?key=' + process.env.VOICE_API_KEY;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: voiceConfig,
        audioConfig: { audioEncoding: "MP3", speakingRate: 1.15 }
      })
    });

    const data: any = await response.json();
    
    if (!response.ok || data.error) {
      console.error("ERRO DO GOOGLE:", data.error || data);
      return res.status(500).json({ error: "Falha na API do Google TTS", details: data.error });
    }

    if (!data.audioContent) {
      return res.status(500).json({ error: "A resposta da API do Google TTS não contém áudio." });
    }

    console.log("BASE64 GERADO COM SUCESSO");
    // O Google TTS retorna o áudio codificado em base64 no atributo audioContent
    res.json({ audioContent: data.audioContent });
  } catch (e) {
    console.error("Erro na rota /voz:", e);
    res.status(500).json({ error: "Falha ao gerar o áudio da voz." });
  }
});

app.listen(3001, () => console.log("🦾 GUTO ONLINE NA PORTA 3001"));

// GUTO PROATIVO: Sistema de pressão contínua (Loop core do produto)
// Comentado pois não está sendo utilizado
// function isTimeToAct(profile: any) {
//   if (!profile?.scheduledTime) return false;
//
//   const now = new Date();
//   const [h, m] = profile.scheduledTime.split(":").map(Number);
//
//   return now.getHours() === h && Math.abs(now.getMinutes() - m) <= 1;
// }

setInterval(async () => {
  // TODO: buscar usuários ativos no banco
  console.log("⏱️ Guto verificando usuários...");

  // Mock example:
  // const user = { scheduledTime: "18:00" };
  // if (isTimeToAct(user)) {
  //   console.log("⚠️ Hora de cobrar treino. Ninguém vai se sabotar hoje.");
  // }
}, 60000);
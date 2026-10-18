// Fil: netlify/functions/intra.js
// Serverless funktion der logger ind på SkoleIntra og henter Beskeder, Lektier & Påmindelser

const BASE_URL = "https://viborgrealskole.m.skoleintra.dk";
const LOGIN_URL = `${BASE_URL}/Account/IdpLogin`;

// Bruger miljøvariabler fra Netlify hvis de er sat, ellers fallback til dine oplysninger
const USERNAME = process.env.INTRA_USER || "jesp47b9";
const PASSWORD = process.env.INTRA_PASS || "bBVLwPwJvsWtJG4_eKNs";

const CHILDREN = [
    { name: "Philip", id: "826103" },
    { name: "Emma", id: "654403" }
];

// Simpel Cookie-Jar til at holde login-sessionen i live på tværs af redirects
class CookieJar {
    constructor() {
        this.cookies = {};
    }
    update(response) {
        let setCookieHeaders = [];
        if (typeof response.headers.getSetCookie === "function") {
            setCookieHeaders = response.headers.getSetCookie();
        } else {
            const raw = response.headers.get("set-cookie");
            if (raw) setCookieHeaders = raw.split(/,(?=\s*[a-zA-Z0-9_\-]+=)/);
        }
        setCookieHeaders.forEach(cookieStr => {
            const firstPart = cookieStr.split(";")[0].trim();
            const eqIdx = firstPart.indexOf("=");
            if (eqIdx > 0) {
                const key = firstPart.substring(0, eqIdx).trim();
                const val = firstPart.substring(eqIdx + 1).trim();
                this.cookies[key] = val;
            }
        });
    }
    getHeader() {
        return Object.entries(this.cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join("; ");
    }
}

// Fetch-funktion der automatisk gemmer cookies ved hvert redirect-hop
async function fetchWithCookies(url, options = {}, jar, maxRedirects = 10) {
    let currentUrl = url;
    let currentOptions = { ...options, redirect: "manual" };

    for (let i = 0; i < maxRedirects; i++) {
        currentOptions.headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
            "Accept-Language": "da-DK,da;q=0.9,en-US;q=0.8",
            ...(currentOptions.headers || {}),
            "Cookie": jar.getHeader()
        };

        const res = await fetch(currentUrl, currentOptions);
        jar.update(res);

        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get("location");
            if (!location) return res;
            currentUrl = new URL(location, currentUrl).toString();
            // Efter en 302/303 POST-redirect skiftes til GET
            if (res.status === 302 || res.status === 303) {
                currentOptions.method = "GET";
                delete currentOptions.body;
                if (currentOptions.headers) {
                    delete currentOptions.headers["Content-Type"];
                }
            }
            continue;
        }
        return res;
    }
    throw new Error("For mange redirects under login");
}

// Udtrækker skjulte input-felter (f.eks. __RequestVerificationToken og SAML-felter)
function extractHiddenInputs(html) {
    const inputs = {};
    const regex = /<input[^>]+>/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
        const tag = match[0];
        const nameMatch = tag.match(/name=["']([^"']+)["']/i);
        const valueMatch = tag.match(/value=["']([^"']*)["']/i);
        const typeMatch = tag.match(/type=["']([^"']+)["']/i);
        if (nameMatch) {
            const type = typeMatch ? typeMatch[1].toLowerCase() : "text";
            if (type === "hidden" || nameMatch[1].includes("Token")) {
                inputs[nameMatch[1]] = valueMatch ? valueMatch[1] : "";
            }
        }
    }
    return inputs;
}

// Udtrækker formens action-URL
function extractFormAction(html, currentUrl) {
    const formMatch = html.match(/<form[^>]*action=["']([^"']+)["'][^>]*>/i);
    if (formMatch && formMatch[1]) {
        return new URL(formMatch[1].replace(/&amp;/g, "&"), currentUrl).toString();
    }
    return currentUrl;
}

// Renser HTML-tags og entiteter til ren tekst
function cleanText(str) {
    if (!str) return "";
    return str
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&#230;/g, "æ")
        .replace(/&#248;/g, "ø")
        .replace(/&#229;/g, "å")
        .replace(/&#198;/g, "Æ")
        .replace(/&#216;/g, "Ø")
        .replace(/&#197;/g, "Å")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}

// Parser HTML fra ForældreIntra efter beskeder, lektier og påmindelser
function parseIntraHtml(html, childName) {
    const items = [];

    // 1. Tjek om SkoleIntra har indlejret JSON-data i siden
    const jsonMatches = html.match(/JSON\.parse\(['"](.+?)['"]\)/g) || [];
    jsonMatches.forEach(jm => {
        try {
            const raw = jm.slice(12, -2).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
            const data = JSON.parse(raw);
            if (Array.isArray(data)) {
                data.slice(0, 8).forEach(entry => {
                    if (entry.Title || entry.Subject || entry.Text) {
                        items.push({
                            child: childName,
                            type: entry.Sender ? "besked" : "lektie",
                            title: cleanText(entry.Title || entry.Subject || "Notits"),
                            sender: cleanText(entry.Sender || entry.Author || ""),
                            date: cleanText(entry.Date || entry.Created || ""),
                            body: cleanText(entry.Text || entry.Description || entry.Content || "")
                        });
                    }
                });
            }
        } catch (e) {}
    });

    // 2. Udtræk listeelementer / kort fra SkoleIntra Mobil- og Web-layout (sk-list-item, sk-message, diary osv.)
    const blockRegex = /<(li|div|article)[^>]*class=["'][^"']*(?:sk-list-item|sk-message|sk-news|sk-diary|sk-homework|list-group-item|message-item|news-item|diary-item)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi;
    let match;
    while ((match = blockRegex.exec(html)) !== null) {
        const block = match[2];
        const titleMatch = block.match(/<(?:h[1-6]|strong|b|span[^>]*class=["'][^"']*(?:title|subject|header)[^"']*["'])[^>]*>([\s\S]*?)<\/(?:h[1-6]|strong|b|span)>/i);
        const textCleaned = cleanText(block);

        if (textCleaned.length > 10 && textCleaned.length < 600) {
            const title = titleMatch ? cleanText(titleMatch[1]) : textCleaned.substring(0, 55);
            const body = textCleaned.replace(title, "").trim();

            let type = "paamindelse";
            if (/lektie|forbered|læs|side|aflever/i.test(textCleaned)) type = "lektie";
            else if (/besked|fra:|emne:|indbakke/i.test(textCleaned)) type = "besked";

            items.push({
                child: childName,
                type,
                title: title || "Info fra SkoleIntra",
                sender: "",
                date: "Акtuel",
                body: body
            });
        }
    }

    // Fjern dubletter
    const unique = [];
    const seen = new Set();
    for (const it of items) {
        const key = `${it.child}-${it.title}-${it.body.substring(0, 30)}`;
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(it);
        }
    }
    return unique.slice(0, 12);
}

exports.handler = async function (event, context) {
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300"
    };

    const jar = new CookieJar();

    try {
        // TRIN 1: Åbn loginsiden og hent session-cookies + CSRF-token
        const initRes = await fetchWithCookies(LOGIN_URL, { method: "GET" }, jar);
        const initHtml = await initRes.text();
        const hiddenInputs = extractHiddenInputs(initHtml);
        const postUrl = extractFormAction(initHtml, initRes.url || LOGIN_URL);

        // Opbyg login-formular (understøtter både SkoleIntra standard-felter og IdpLogin-felter)
        const formData = new URLSearchParams();
        Object.entries(hiddenInputs).forEach(([k, v]) => formData.append(k, v));
        formData.set("UserName", USERNAME);
        formData.set("Password", PASSWORD);
        formData.set("username", USERNAME);
        formData.set("password", PASSWORD);
        formData.set("RoleType", "Parent");

        // TRIN 2: Send login POST
        let loginRes = await fetchWithCookies(
            postUrl,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Origin": BASE_URL,
                    "Referer": LOGIN_URL
                },
                body: formData.toString()
            },
            jar
        );

        let currentHtml = await loginRes.text();

        // Hvis loginsiden returnerer en SAML/OIDC auto-submit formular, følger vi den automatisk
        if (currentHtml.includes("SAMLResponse") || currentHtml.includes("wresult") || currentHtml.includes("onload=\"document.forms[0].submit()\"")) {
            const samlInputs = extractHiddenInputs(currentHtml);
            const samlAction = extractFormAction(currentHtml, loginRes.url || BASE_URL);
            const samlForm = new URLSearchParams();
            Object.entries(samlInputs).forEach(([k, v]) => samlForm.append(k, v));

            loginRes = await fetchWithCookies(
                samlAction,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: samlForm.toString()
                },
                jar
            );
            currentHtml = await loginRes.text();
        }

        const results = {
            authenticated: !currentHtml.includes("Forkert brugernavn") && !currentHtml.includes("IdpLogin"),
            updatedAt: new Date().toISOString(),
            items: []
        };

        // TRIN 3: Hent Forside/Påmindelser, Lektier (Diary) og Beskeder for både Philip og Emma
        for (const child of CHILDREN) {
            const endpoints = [
                { type: "forside", url: `${BASE_URL}/parent/${child.id}//item/index` },
                { type: "lektier", url: `${BASE_URL}/parent/${child.id}//diary/diary` },
                { type: "beskeder", url: `${BASE_URL}/parent/${child.id}//message/index` },
                { type: "feed-diary", url: `${BASE_URL}/feed/GetFeed?type=Diary&unifiedId=${child.id}&culture=da-DK` }
            ];

            for (const ep of endpoints) {
                try {
                    const res = await fetchWithCookies(ep.url, { method: "GET" }, jar);
                    if (res.ok) {
                        const text = await res.text();
                        const parsed = parseIntraHtml(text, child.name);
                        results.items.push(...parsed);
                    }
                } catch (innerErr) {
                    console.warn(`Kunne ikke hente ${ep.type} for ${child.name}:`, innerErr.message);
                }
            }
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(results)
        };
    } catch (error) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                authenticated: false,
                error: error.message,
                items: []
            })
        };
    }
};
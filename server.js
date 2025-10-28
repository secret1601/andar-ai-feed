// server.js
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import * as fs from "fs/promises";

// Vercel 환경이 아닐 때(로컬 환경)만 dotenv를 실행합니다.
if (process.env.NODE_ENV !== 'production' || process.env.VERCEL === undefined) {
    console.log("Running in local environment, loading .env file...");
    dotenv.config({ path: path.resolve(process.cwd(), '.env') });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- 토큰 저장을 위한 글로벌 변수 (Vercel에서는 휘발성) ---
let ACCESS_TOKEN = null;
let REFRESH_TOKEN = null;
let TOKEN_EXPIRY = 0;

// --- 환경 변수 및 상수 ---
const MALL_ID = process.env.CAFE24_MALL_ID;
const CLIENT_ID = process.env.CAFE24_CLIENT_ID;
const SECRET_KEY = process.env.CAFE24_SECRET_KEY;
const API_SCOPE = process.env.CAFE24_API_SCOPE;
const AUTH_URL = `https://${MALL_ID}.cafe24api.com/oauth/token`;
const PRODUCT_URL = `https://${MALL_ID}.cafe24api.com/api/v2/products`;

// 🚨 Vercel 배포 도메인과 Cafe24 Redirect URI(s)에 등록된 URL이 정확히 일치해야 합니다.
const VERCEL_DOMAIN = "https://andar-ai-feed.vercel.app"; 
const REDIRECT_URI = `${VERCEL_DOMAIN}/`; // Cafe24에 등록된 Redirect URI

// ----------------------------------------------------
// 1. 토큰 갱신 함수 (Refresh Token 사용)
// ----------------------------------------------------
async function refreshAccessToken() {
    if (!REFRESH_TOKEN) {
        throw new Error("Not authorized. No refresh token available. Please visit /auth to authorize the app.");
    }

    console.log("Access Token expired. Refreshing...");
    try {
        const data = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: REFRESH_TOKEN,
            client_id: CLIENT_ID,
            client_secret: SECRET_KEY
        }).toString();

        const response = await fetch(AUTH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: data
        });

        if (!response.ok) {
            const errorText = await response.text();
            ACCESS_TOKEN = null;
            REFRESH_TOKEN = null; // 리프레시 토큰이 만료되었을 수 있음
            throw new Error(`Refresh token failed: ${errorText}. Please re-authorize at /auth.`);
        }

        const tokenData = await response.json();
        ACCESS_TOKEN = tokenData.access_token;
        REFRESH_TOKEN = tokenData.refresh_token || REFRESH_TOKEN; // 새 리프레시 토큰을 주면 갱신
        TOKEN_EXPIRY = Date.now() + (tokenData.expires_in * 1000);
        console.log("Token refreshed successfully.");
        return ACCESS_TOKEN;

    } catch (error) {
        console.error("Refresh Access Token Error:", error.message);
        throw error;
    }
}

// ----------------------------------------------------
// 2. 토큰 가져오기 (게이트키퍼)
// ----------------------------------------------------
async function getAccessToken() {
    // 토큰이 유효하면 즉시 반환
    if (ACCESS_TOKEN && Date.now() < TOKEN_EXPIRY - 300000) {
        console.log("Using cached Access Token.");
        return ACCESS_TOKEN;
    }
    // 만료되었거나 없으면 갱신 시도
    return await refreshAccessToken();
}

// ----------------------------------------------------
// 3. (신규) 인증 시작 라우트
// 관리자가 1회 수동으로 방문해야 하는 경로
// ----------------------------------------------------
app.get('/auth', (req, res) => {
    const authUrl = `https://${MALL_ID}.cafe24api.com/api/v2/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&scope=${API_SCOPE}&redirect_uri=${REDIRECT_URI}`;
    console.log("Redirecting to Cafe24 for authorization...");
    res.redirect(authUrl);
});

// ----------------------------------------------------
// 4. (수정) 루트 경로 ('/') - 인증 콜백(Redirect URI) 처리
// ----------------------------------------------------
app.get('/', async (req, res) => {
    const { code } = req.query;

    // 1. 인증 코드가 없는 경우 (일반 방문)
    if (!code) {
        // AI-FEED 페이지로 리디렉션
        return res.redirect('/ai-feed');
    }

    // 2. 인증 코드가 있는 경우 (Cafe24가 리디렉션한 경우)
    console.log("Authorization code received. Exchanging for token...");
    try {
        const data = new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT_ID,
            client_secret: SECRET_KEY
        }).toString();

        const response = await fetch(AUTH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: data
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Token exchange failed: ${errorText}`);
        }

        const tokenData = await response.json();
        ACCESS_TOKEN = tokenData.access_token;
        REFRESH_TOKEN = tokenData.refresh_token; // 🚨 매우 중요: 이 토큰을 DB에 저장해야 함
        TOKEN_EXPIRY = Date.now() + (tokenData.expires_in * 1000);

        console.log("Token exchange successful! Redirecting to /ai-feed.");
        // 성공! 이제 AI-FEED 페이지로 이동
        res.redirect('/ai-feed');

    } catch (err) {
        console.error("Auth callback error:", err);
        res.status(500).send(`Authentication failed: ${err.message}`);
    }
});

// ----------------------------------------------------
// 5. (수정) AI-FEED 라우트
// ----------------------------------------------------
app.get('/ai-feed', async (req, res) => {
    try {
        console.log("AI-FEED 요청 수신.");
        // 1. Access Token 확보 (갱신 로직 포함)
        const token = await getAccessToken();

        // 2. 모든 상품 데이터 조회를 위한 페이징 처리
        const allProducts = [];
        let page = 1;
        const limit = 100;

        while (true) {
            console.log(`Fetching product page ${page}...`);
            const productResponse = await fetch(
                `${PRODUCT_URL}?limit=${limit}&page=${page}`,
                {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!productResponse.ok) {
                const errorData = await productResponse.json();
                throw new Error(`상품 API 호출 실패: ${productResponse.status} - ${JSON.stringify(errorData)}`);
            }

            const productData = await productResponse.json();
            const products = productData.products;

            if (products.length === 0) {
                console.log("모든 상품 데이터 수집 완료.");
                break;
            }
            allProducts.push(...products);
            if (products.length < limit) {
                console.log("마지막 페이지 수집 완료.");
                break;
            }
            page++;
        }

        // 3. JSON-LD 데이터 생성 (기존과 동일)
        const jsonLdData = allProducts.map((product, index) => ({
            "@context": "https://schema.org",
            "@type": "Product",
            "name": product.product_name,
            "image": product.detail_image || product.list_image,
            "url": `https://${MALL_ID}.com/product/detail.html?product_no=${product.product_no}`,
            "sku": product.product_no,
            "offers": {
                "@type": "Offer",
                "price": product.price,
                "priceCurrency": "KRW",
                "availability": "https://schema.org/" + (product.stock_quantity > 0 ? "InStock" : "OutOfStock")
            }
        }));

        // 4. JSON-LD 스크립트 태그 생성
        const jsonLdScript = `<script type="application/ld+json">${JSON.stringify(jsonLdData, null, 2)}</script>`;

        // 5. HTML 템플릿 로드 및 삽입
        const htmlTemplatePath = path.join(__dirname, 'public', 'ai-feed.html');
        let htmlContent = await fs.readFile(htmlTemplatePath, 'utf8');
        htmlContent = htmlContent.replace('</head>', `${jsonLdScript}\n</head>`);

        // 6. 최종 HTML 응답
        res.setHeader('Content-Type', 'text/html');
        res.send(htmlContent);

    } catch (err) {
        // 런타임 오류 또는 인증 오류 발생 시
        console.error("AI-FEED 처리 중 심각한 오류 발생:", err);
        // 🚨 인증 실패 시 수동 인증 페이지로 안내
        res.status(500).send(`
            <!DOCTYPE html>
            <html lang="ko">
            <head><meta charset="UTF-8"><title>Error</title></head>
            <body>
                <h1>Error retrieving AI-FEED data</h1>
                <p>An error occurred: ${err.message}</p>
                <p>Please check the server logs for more details.</p>
                <hr>
                <p>If authorization is required, please <a href="/auth">click here to authorize the app</a>.</p>
            </body></html>
        `);
    }
});

// 정적 파일 서빙 (public 폴더)
app.use(express.static(path.join(__dirname, 'public')));

// 로컬 테스트용
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Local Test] Server running on http://localhost:${PORT}`));

// Vercel 서버리스 환경을 위해 app을 export합니다.
export default app;
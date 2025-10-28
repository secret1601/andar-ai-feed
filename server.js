// server.js
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
// fs/promises를 fs로 가져와서 fs.readFile을 사용합니다.
import * as fs from "fs/promises";

// Vercel 환경이 아닐 때(로컬 환경)만 dotenv를 실행합니다.
// Vercel은 환경 변수를 자동으로 주입합니다.
if (process.env.NODE_ENV !== 'production' || process.env.VERCEL === undefined) {
    console.log("Running in local environment, loading .env file...");
    dotenv.config({ path: path.resolve(process.cwd(), '.env') });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Access Token을 전역 변수로 저장하고 관리합니다.
let ACCESS_TOKEN = null;
let TOKEN_EXPIRY = 0; // 토큰 만료 시간 (Unix Timestamp)

const MALL_ID = process.env.CAFE24_MALL_ID;
const CLIENT_ID = process.env.CAFE24_CLIENT_ID;
const SECRET_KEY = process.env.CAFE24_SECRET_KEY;
const API_SCOPE = process.env.CAFE24_API_SCOPE;
const AUTH_URL = `https://${MALL_ID}.cafe24api.com/oauth/token`;
const PRODUCT_URL = `https://${MALL_ID}.cafe24api.com/api/v2/products`;

// ----------------------------------------------------
// Access Token 발급 및 갱신 함수
// ----------------------------------------------------
async function getAccessToken() {
    // 토큰이 유효한 시간(만료 5분 전)이면 기존 토큰을 반환
    if (ACCESS_TOKEN && Date.now() < TOKEN_EXPIRY - 300000) {
        console.log("Using cached Access Token.");
        return ACCESS_TOKEN;
    }

    console.log("Access Token 만료 또는 없음. 새로 발급합니다...");

    try {
        const data = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: CLIENT_ID,
            client_secret: SECRET_KEY,
            scope: API_SCOPE
        }).toString();

        const response = await fetch(AUTH_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: data
        });

        if (!response.ok) {
            // 🚨 인증 실패 시 HTML 응답을 텍스트로 처리 (오류 수정)
            const errorData = await response.text();
            // 🚨 변수 이름 수정 (errorText -> errorData)
            throw new Error(`Token 발급 실패: ${response.status} - ${errorData.substring(0, 150)}...`);
        }

        const tokenData = await response.json();

        ACCESS_TOKEN = tokenData.access_token;
        TOKEN_EXPIRY = Date.now() + (tokenData.expires_in * 1000);
        console.log("Access Token 발급 성공.");

        return ACCESS_TOKEN;

    } catch (error) {
        console.error("인증 에러:", error.message);
        ACCESS_TOKEN = null; // 실패 시 초기화
        throw new Error(error.message || "CAFE24 인증 서버 연결 실패.");
    }
}

// ----------------------------------------------------
// 루트 경로 ('/') 리디렉션
// ----------------------------------------------------
app.get('/', (req, res) => {
    // Vercel의 기본 접속 경로(/)에 대한 처리입니다.
    // 사용자를 실제 AI-FEED 페이지로 리디렉션합니다.
    res.redirect('/ai-feed');
});

// ----------------------------------------------------
// AI-FEED 라우트: 토큰 발급 후 데이터 조회 및 HTML 렌더링
// ----------------------------------------------------
app.get('/ai-feed', async (req, res) => {
    try {
        console.log("AI-FEED 요청 수신.");
        // 1. Access Token 확보 (필요시 새로 발급)
        const token = await getAccessToken();

        // 2. 💡 모든 상품 데이터 조회를 위한 페이징 처리
        const allProducts = [];
        let page = 1;
        const limit = 100; // API가 허용하는 최대치

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
                // 더 이상 상품이 없으면 반복 종료
                console.log("모든 상품 데이터 수집 완료.");
                break;
            }

            allProducts.push(...products);

            // 가져온 상품 개수가 limit보다 적으면 마지막 페이지
            if (products.length < limit) {
                console.log("마지막 페이지 수집 완료.");
                break;
            }

            page++;
        }

        // 3. JSON-LD 데이터 생성
        const jsonLdData = allProducts.map((product, index) => ({
            "@context": "https://schema.org",
            "@type": "Product",
            "name": product.product_name,
            "image": product.detail_image || product.list_image,
            "url": `https://${MALL_ID}.com/product/detail.html?product_no=${product.product_no}`, // 실제 쇼핑몰 URL 형식 확인 필요
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
        // 🚨 fs.readFile로 수정 (fs.promises.readFile 대신)
        let htmlContent = await fs.readFile(htmlTemplatePath, 'utf8');

        // public/ai-feed.html 파일의 </head> 태그 바로 위에 삽입
        htmlContent = htmlContent.replace('</head>', `${jsonLdScript}\n</head>`);

        // 6. 최종 HTML 응답
        res.setHeader('Content-Type', 'text/html');
        res.send(htmlContent);

    } catch (err) {
        // 런타임 오류 또는 인증 오류 발생 시
        console.error("AI-FEED 처리 중 심각한 오류 발생:", err);
        res.status(500).send(`
            <!DOCTYPE html>
            <html lang="ko">
            <head><meta charset="UTF-8"><title>Error</title></head>
            <body>
                <h1>Error retrieving AI-FEED data</h1>
                <p>An error occurred: ${err.message}</p>
                <p>Please check the server logs for more details.</p>
            </body></html>
        `);
    }
});

// 정적 파일 서빙 (public 폴더) - Vercel에서는 vercel.json이 우선될 수 있음
app.use(express.static(path.join(__dirname, 'public')));

// Vercel은 이 파일을 서버리스 함수로 실행하므로 app.listen()이 필요하지 않습니다.
// 단, package.json의 "start" 스크립트("node server.js")는 Vercel 빌드를 위해 존재합니다.
// 로컬 테스트를 위해 app.listen()을 남겨둘 수 있습니다.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Local Test] Server running on http://localhost:${PORT}`));

// Vercel 서버리스 환경을 위해 app을 export합니다. (vercel.json 설정과 연동)
export default app;
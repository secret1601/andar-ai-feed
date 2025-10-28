// server.js
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv"; // 'dotenv' 패키지명으로 수정
import path from "path";
import { fileURLToPath } from "url";

// dotenv 설정 시 경로를 명시하는 것이 안정적입니다.
dotenv.config({ path: path.resolve(process.cwd(), '.env') }); 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

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
            const errorData = await response.json();
            throw new Error(`Token 발급 실패: ${response.status} - ${JSON.stringify(errorData)}`);
        }

        const tokenData = await response.json();
        
        ACCESS_TOKEN = tokenData.access_token;
        // 만료 시간 설정 (현재 시간 + 유효 시간(초) * 1000ms)
        TOKEN_EXPIRY = Date.now() + (tokenData.expires_in * 1000); 
        console.log("Access Token 발급 성공.");
        
        return ACCESS_TOKEN;

    } catch (error) {
        console.error("인증 에러:", error.message);
        ACCESS_TOKEN = null; // 실패 시 초기화
        throw new Error("CAFE24 인증 서버에 연결할 수 없습니다.");
    }
}


// ----------------------------------------------------
// AI-FEED 라우트: 토큰 발급 후 데이터 조회 및 HTML 렌더링
// ----------------------------------------------------
app.get('/ai-feed', async (req, res) => {
    try {
        // 1. Access Token 확보 (필요시 새로 발급)
        const token = await getAccessToken();

        // 2. 상품 데이터 조회
        const productResponse = await fetch(
            `${PRODUCT_URL}?limit=100`, // 페이징 처리 필요 (현재는 100개만 가져오도록 설정)
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

        // 3. JSON-LD 데이터 생성
        const jsonLdData = productData.products.map((product, index) => ({
            "@context": "https://schema.org",
            "@type": "Product",
            // Product 스키마 사용 시 ItemList가 아닌 개별 Product로 구성하는 것이 좋습니다.
            // 리치 검색 결과를 위해서는 'offers' 속성이 필수입니다.
            "name": product.product_name,
            "image": product.detail_image || product.list_image,
            "url": `https://${MALL_ID}.com/product/detail.html?product_no=${product.product_no}`, // 정확한 URL 형식으로 수정
            "sku": product.product_no,
            "offers": {
                "@type": "Offer",
                "price": product.price,
                "priceCurrency": "KRW",
                "availability": "https://schema.org/" + (product.stock_quantity > 0 ? "InStock" : "OutOfStock") // 재고 정보에 따라 동적 설정
            }
        }));

        // 4. JSON-LD 스크립트 태그 생성
        const jsonLdScript = `<script type="application/ld+json">${JSON.stringify(jsonLdData, null, 2)}</script>`;

        // 5. HTML 템플릿 로드 및 삽입
        const htmlTemplatePath = path.join(__dirname, 'public', 'ai-feed.html');
        let htmlContent = await fs.promises.readFile(htmlTemplatePath, 'utf8');

        // JSON-LD를 삽입할 위치를 마커로 지정하고 치환합니다.
        // public/ai-feed.html 파일에서 ''와 같은 마커 사용을 추천합니다.
        // 현재는 간단하게 헤드 태그에 삽입한다고 가정합니다.
        htmlContent = htmlContent.replace('</head>', `${jsonLdScript}\n</head>`);


        // 6. 최종 HTML 응답
        res.setHeader('Content-Type', 'text/html');
        res.send(htmlContent);

    } catch (err) {
        console.error(err);
        res.status(500).send(`
            <!DOCTYPE html>
            <html><body>
                <h1>Error retrieving AI-FEED data</h1>
                <p>An error occurred: ${err.message}</p>
            </body></html>
        `);
    }
});

// 정적 파일 서빙은 계속 유지 (public 폴더 내의 기타 파일)
app.use(express.static(path.join(__dirname, 'public')));


app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
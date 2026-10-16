/**
 * percent_bot.js - 라면 최저가 알리미 봇
 * 
 * [요구사항 구현 내역]
 * 1. 네이버 쇼핑 검색 스킬로 '농심 신라면 멀티 20개입'을 최저가 순서로 찾는다.
 * 2. 저렴한 순서로 상품 3개를 상품명·가격·쇼핑몰·리뷰 수·링크와 함께 화면에 보기 좋게 출력한다.
 * 3. 엉뚱한 광고 상품은 제거하고 오리지널 신라면 20개입 진짜 상품만 골라낸다.
 * 4. 1위 가격이 목표가 15000원 이하인지 확인해 다음 중 하나를 함께 출력한다.
 *    - 목표가 이하일 때: "🚨 [특가 알림] 목표 가격 이하입니다!"
 *    - 목표가 초과일 때: "ℹ️ [유지] 아직 목표 가격보다 비쌉니다."
 * 5. 값을 못 가져오면 지어내지 말고, 무엇이 잘못됐는지 그대로 알려 주고 멈춘다.
 */

const fs = require('fs');

const TARGET_PRICE = 15000;
const SEARCH_KEYWORD = '농심 신라면 멀티 20개입';

// HTML 태그 제거 및 공백 정규화
function cleanText(text) {
  if (!text) return '';
  return String(text)
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// 스마트스토어/공식몰 직통 링크 복원
function resolveProductLink(product) {
  const channelProductId = product.channelProductId || product.originalMallProductId;
  let storeId = null;

  const mallPcUrl = product.mallUrl?.pcUrl || '';
  const matchOutlink = mallPcUrl.match(/url=https%3A%2F%2F(?:m\.)?smartstore\.naver\.com%2F([^%&/?]+)/i);
  if (matchOutlink) {
    storeId = decodeURIComponent(matchOutlink[1]);
  } else {
    const directMatch = mallPcUrl.match(/smartstore\.naver\.com\/([^/?#]+)/i);
    if (directMatch) storeId = directMatch[1];
  }

  // 농심 브랜드스토어
  if (product.isBrandStore && (storeId === 'nongsim_main' || !storeId)) {
    return `https://brand.naver.com/nongshim/products/${channelProductId}`;
  }

  // 일반 스마트스토어
  if (storeId && channelProductId) {
    return `https://smartstore.naver.com/${storeId}/products/${channelProductId}`;
  }

  // 브릿지/클릭 링크
  if (product.productClickUrl?.pcUrl) {
    return product.productClickUrl.pcUrl;
  }
  if (product.productUrl?.pcUrl) {
    return product.productUrl.pcUrl;
  }

  // 카탈로그
  if (product.nvMid) {
    return `https://search.shopping.naver.com/catalog/${product.nvMid}`;
  }

  return null;
}

// 1. 네이버 쇼핑 스킬 프록시 호출
async function fetchFromSkillProxy(keyword) {
  const url = `https://k-skill-proxy.nomadamas.org/v1/naver-shopping/search?q=${encodeURIComponent(keyword)}&sort=price_asc&limit=20`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `프록시 응답 HTTP ${res.status}: ${body.slice(0, 150)}` };
    }
    const data = await res.json();
    return { ok: true, data: data.items || [] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 2. 검색 엔진 실시간 fallback 질의
async function fetchFromSearchEngine(keyword) {
  const url = `https://search.naver.com/search.naver?where=nexearch&query=${encodeURIComponent(keyword)}`;
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'ko-KR,ko;q=0.9'
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) {
    throw new Error(`네이버 검색 응답 실패: HTTP ${res.status}`);
  }

  const html = await res.text();
  const re = /\._INITIAL_STATE\s*=\s*(\{[\s\S]*?\});?\s*(?:naver\.|\n|<\/script>)/g;
  let match;
  const rawProducts = [];

  while ((match = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      const paged = parsed.initProps?.pagedSlot || [];
      for (const p of paged) {
        for (const s of (p.slots || [])) {
          if (s.data) rawProducts.push(s.data);
        }
      }
      const prods = parsed.initProps?.products || [];
      for (const p of prods) {
        rawProducts.push(p);
      }
    } catch (e) {}
  }

  return rawProducts;
}

// 3. 광고 상품 제거 및 오리지널 신라면 20개 정밀 선별
function filterOriginalShin20(products) {
  const filtered = [];
  const seenKeys = new Set();

  for (const p of products) {
    // [규칙 1] 엉뚱한 광고 상품 제거 (AD_CARD, isAd 등)
    const isAd = p.cardType === 'AD_CARD' || p.isAd === true || p.sourceType === 'AD' || Boolean(p.adFlag);
    if (isAd) continue;

    const rawTitle = p.productNameOrg || p.productName || p.nStoreExtraInfo?.standardProductName || p.standardProductName || p.title || '';
    const title = cleanText(rawTitle);
    const lower = title.toLowerCase();

    // [규칙 2] 신라면 브랜드 확인
    if (!lower.includes('신라면')) continue;

    // [규칙 3] 변형 라면 및 타 라면 완전 제외
    const forbidden = ['블랙', '건면', '골드', '더레드', '툼바', '볶음면', '두부김치', '컵라면', '사발면', '소컵', '큰사발'];
    if (forbidden.some(f => lower.includes(f))) continue;

    const mixed = ['안성탕면', '너구리', '짜파게티', '오징어짬뽕', '진라면', '삼양', '혼합', '비빔면'];
    if (mixed.some(m => lower.includes(m))) continue;

    // [규칙 4] 오직 20개/20봉/20개입 구성만 허용
    const is20 = lower.includes('20개') || lower.includes('20봉') || lower.includes('20ea') ||
                 lower.includes('20입') || lower.includes('20 개') ||
                 (lower.includes('5개입') && lower.includes('4')) ||
                 lower.includes('총 20');
    if (!is20) continue;

    // 가격 추출
    const price = Number(p.discountedSalePrice || p.salePrice || p.lowPrice || p.price);
    if (!price || isNaN(price) || price <= 0) continue;

    const deliveryFee = Number(p.productDeliveryInfo?.deliveryFee || p.deliveryFee || 0);
    const totalPrice = price + deliveryFee;

    // 링크 추출
    const link = resolveProductLink(p) || p.url || p.link;
    if (!link) continue;

    // 중복 제거 키
    const dedupKey = `${price}_${title.slice(0, 15)}`;
    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);

    // 쇼핑몰명 정규화
    let mallName = cleanText(p.mallName || p.sellerName || p.channelName || '');
    if (!mallName && p.cardType === 'CATALOG_CARD') {
      const mallCount = p.shoppingExtraInfo?.mallCount;
      mallName = mallCount ? `네이버 쇼핑 가격비교 (${mallCount.toLocaleString()}개 몰 최저가)` : '네이버 쇼핑 가격비교';
    } else if (!mallName) {
      mallName = '네이버 쇼핑 입점몰';
    }

    // 리뷰 수
    const reviewCount = Number(p.totalReviewCount || p.reviewCount || p.nStoreExtraInfo?.totalReviewCount6Month || 0);

    filtered.push({
      title: title,
      price: price,
      deliveryFee: deliveryFee,
      totalPrice: totalPrice,
      mallName: mallName,
      reviewCount: reviewCount,
      link: link
    });
  }

  // 가격 낮은 순서 정렬 (기본 상품가 오름차순)
  filtered.sort((a, b) => a.price - b.price);
  return filtered;
}

async function runBot() {
  console.log('='.repeat(65));
  console.log(`🍜 [percent_bot] 라면 최저가 알리미 가동`);
  console.log(`🔍 검색 키워드: '${SEARCH_KEYWORD}'`);
  console.log(`🎯 알림 목표가: ${TARGET_PRICE.toLocaleString()}원 이하`);
  console.log('='.repeat(65));

  let rawProducts = [];

  // CLI 인자 및 환경변수 확인 (테스트/모의 데이터 지원)
  const args = process.argv.slice(2);
  let mockFilePath = process.env.PERCENT_BOT_MOCK_FILE || null;
  let mockJsonData = process.env.PERCENT_BOT_MOCK_JSON || null;
  let forceErrorMsg = process.env.PERCENT_BOT_FORCE_ERROR || null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mock-file' && args[i + 1]) {
      mockFilePath = args[i + 1];
      i++;
    } else if (args[i] === '--mock-json' && args[i + 1]) {
      mockJsonData = args[i + 1];
      i++;
    } else if (args[i] === '--force-error') {
      forceErrorMsg = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : '네트워크 연결 오류 (Connection refused)';
      if (args[i + 1] && !args[i + 1].startsWith('--')) i++;
    }
  }

  // [테스트 1] 강제 에러 시뮬레이션: 네트워크 장애 시 지어내지 않고 오류 알림
  if (forceErrorMsg) {
    console.error(`\n❌ [오류 발생] 상품 데이터를 가져오지 못했습니다.`);
    console.error(`   상세 내용: ${forceErrorMsg}`);
    console.error(`   임의로 가짜 데이터를 지어내지 않고 안전하게 봇을 중단합니다.`);
    process.exit(1);
  }

  // [테스트 2] 모의 데이터 주입 모드
  if (mockFilePath || mockJsonData) {
    console.log(`📡 [모의 테스트 모드] 외부 가짜 데이터를 주입합니다. (실제 네이버 요청 차단)`);
    try {
      if (mockFilePath) {
        const rawContent = fs.readFileSync(mockFilePath, 'utf-8');
        rawProducts = JSON.parse(rawContent);
      } else {
        rawProducts = JSON.parse(mockJsonData);
      }
      console.log(`   └ 가짜 데이터 총 ${rawProducts.length}개 로드 완료`);
    } catch (err) {
      console.error(`\n❌ [오류 발생] 상품 데이터를 가져오지 못했습니다.`);
      console.error(`   상세 내용: 가짜 데이터 파싱 실패: ${err.message}`);
      console.error(`   임의로 가짜 데이터를 생성하지 않고 안전하게 봇을 중단합니다.`);
      process.exit(1);
    }
  } else {
    // [1단계] 네이버 쇼핑 검색 스킬 엔드포인트 호출
    process.stdout.write(`📡 1단계: 네이버 쇼핑 검색 스킬 API 호출 중... `);
    const proxyResult = await fetchFromSkillProxy(SEARCH_KEYWORD);

    if (proxyResult.ok && proxyResult.data.length > 0) {
      console.log(`[성공] (${proxyResult.data.length}건 수신)`);
      rawProducts = proxyResult.data;
    } else {
      console.log(`[안내: 공식 프록시 upstream 오류로 실시간 fallback 전환]`);
      if (proxyResult.error) {
        console.log(`   └ 사유: ${proxyResult.error}`);
      }
      console.log(`📡 2단계: 실시간 쇼핑 검색 데이터 수집을 시작합니다...`);

      try {
        // 1차 검색: '농심 신라면 멀티 20개입'
        const res1 = await fetchFromSearchEngine(SEARCH_KEYWORD);
        rawProducts.push(...res1);

        // 연관 질의 추가 수집으로 상품군 확보: '농심 신라면 120g 20개'
        const res2 = await fetchFromSearchEngine('농심 신라면 120g 20개');
        rawProducts.push(...res2);

        console.log(`   └ 실시간 검색 결과 총 ${rawProducts.length}개 원본 수신 완료`);
      } catch (err) {
        // [5단계] 값을 못 가져오면 지어내지 않고 오류 출력 후 종료
        console.error(`\n❌ [오류 발생] 상품 데이터를 가져오지 못했습니다.`);
        console.error(`   상세 내용: ${err.message}`);
        console.error(`   임의로 가짜 데이터를 생성하지 않고 안전하게 봇을 중단합니다.`);
        process.exit(1);
      }
    }
  }

  // [3단계] 엉뚱한 광고 상품 제거 및 오리지널 신라면 20개 필터링
  const validProducts = filterOriginalShin20(rawProducts);

  if (validProducts.length === 0) {
    // [5단계] 지어내지 않고 원인 알림 후 중단
    console.error(`\n⚠️ [검색 결과 없음] 광고를 제외한 '오리지널 신라면 20개입' 유효 상품을 찾지 못했습니다.`);
    console.error(`   - 검색된 원본 항목 수: ${rawProducts.length}건`);
    console.error(`   - 원인: 검색된 상품이 모두 광고이거나, 변형 신라면(블랙/건면/골드) 또는 타 라면 혼합 구성이었습니다.`);
    console.error(`   임의로 가짜 데이터를 지어내지 않고 봇을 종료합니다.`);
    process.exit(1);
  }

  // [2단계] 저렴한 순서로 상품 3개 선별
  const top3 = validProducts.slice(0, 3);

  console.log(`\n📦 [선별 결과] 오리지널 신라면 20개입 최저가 TOP 3:`);
  console.log('-'.repeat(65));

  top3.forEach((item, index) => {
    const rank = index + 1;
    const badge = rank === 1 ? '🥇 1위' : rank === 2 ? '🥈 2위' : '🥉 3위';
    const deliveryStr = item.deliveryFee === 0 ? '무료배송' : `+배송비 ${item.deliveryFee.toLocaleString()}원`;

    console.log(`${badge} ${item.title}`);
    console.log(`   • 가격   : ${item.price.toLocaleString()}원 (${deliveryStr})`);
    console.log(`   • 쇼핑몰 : ${item.mallName}`);
    console.log(`   • 리뷰 수: ${item.reviewCount.toLocaleString()}개`);
    console.log(`   • 링크   : ${item.link}`);
    console.log('-'.repeat(65));
  });

  // [4단계] 1위 가격이 목표가 15000원 이하인지 확인
  const top1 = top3[0];
  console.log(`\n📊 [목표 가격 판정]`);
  console.log(`   • 1위 최저가: ${top1.price.toLocaleString()}원 (배송비 별도 ${top1.deliveryFee.toLocaleString()}원)`);
  console.log(`   • 설정 목표가: ${TARGET_PRICE.toLocaleString()}원`);

  if (top1.price <= TARGET_PRICE) {
    console.log(`\n🚨 [특가 알림] 목표 가격 이하입니다!`);
  } else {
    console.log(`\nℹ️ [유지] 아직 목표 가격보다 비쌉니다.`);
  }
  console.log('='.repeat(65));

  // percent_bot.py 연동용 구조화 요약 데이터 마커 출력
  const summaryPayload = {
    keyword: SEARCH_KEYWORD,
    targetPrice: TARGET_PRICE,
    isTargetMet: top1.price <= TARGET_PRICE,
    top1: {
      title: top1.title,
      price: top1.price,
      deliveryFee: top1.deliveryFee,
      totalPrice: top1.totalPrice,
      mallName: top1.mallName,
      reviewCount: top1.reviewCount,
      link: top1.link
    }
  };
  console.log(`__PERCENT_BOT_SUMMARY__:${JSON.stringify(summaryPayload)}`);
}

runBot().catch(err => {
  console.error('\n❌ [치명적 오류]', err);
  process.exit(1);
});

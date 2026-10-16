import subprocess
import sys
import os
import json
import urllib.request
import urllib.parse
import urllib.error

# Windows 터미널 인코딩(cp949) 출력 호환성 보장
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def load_env(env_path):
    """
    .env 파일에서 환경변수를 로드합니다.
    외부 라이브러리(python-dotenv) 의존성 없이 표준 라이브러리로 안전하게 동작합니다.
    """
    env_vars = {}
    if not os.path.exists(env_path):
        return env_vars

    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    key, val = line.split("=", 1)
                    key = key.strip()
                    val = val.strip().strip("'\"")
                    env_vars[key] = val
    except Exception as e:
        print(f"⚠️ [.env 읽기 오류] .env 파일을 읽는 중 오류가 발생했습니다: {e}", file=sys.stderr)
    return env_vars


def update_env_file(env_path, key, new_val):
    """
    토큰 갱신 시 .env 파일의 특정 키 값을 새 값으로 업데이트합니다.
    """
    if not os.path.exists(env_path):
        return
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            lines = f.readlines()

        found = False
        new_lines = []
        for line in lines:
            if line.strip().startswith(f"{key}="):
                new_lines.append(f"{key}={new_val}\n")
                found = True
            else:
                new_lines.append(line)
        if not found:
            new_lines.append(f"{key}={new_val}\n")

        with open(env_path, "w", encoding="utf-8") as f:
            f.writelines(new_lines)
    except Exception:
        pass


def refresh_kakao_token(env_path, rest_api_key, refresh_token, client_secret=None):
    """
    리프레시 토큰을 이용해 새로운 액세스 토큰을 발급받습니다.
    """
    if not rest_api_key or not refresh_token:
        return False, "REST API 키 또는 리프레시 토큰이 누락되었습니다."

    url = "https://kauth.kakao.com/oauth/token"
    params = {
        "grant_type": "refresh_token",
        "client_id": rest_api_key,
        "refresh_token": refresh_token,
    }
    if client_secret:
        params["client_secret"] = client_secret

    data = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded;charset=utf-8")

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp_body = resp.read().decode("utf-8")
            result = json.loads(resp_body)
            new_access_token = result.get("access_token")
            if new_access_token:
                update_env_file(env_path, "KAKAO_ACCESS_TOKEN", new_access_token)
                if result.get("refresh_token"):
                    update_env_file(env_path, "KAKAO_REFRESH_TOKEN", result.get("refresh_token"))
                return True, new_access_token
            return False, f"응답에 새 access_token이 없습니다: {resp_body}"
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        return False, f"HTTP {e.code} ({err_body})"
    except Exception as e:
        return False, str(e)


def send_kakao_memo(top1, script_dir):
    """
    1위 상품 정보를 카카오톡 '나에게 보내기'로 전송합니다.
    실패 시 원인을 상세히 출력합니다. (보낸 척하지 않고 명확한 에러 내용 표시)
    """
    env_path = os.path.join(script_dir, ".env")
    if not os.path.exists(env_path):
        print("\n❌ [카카오톡 알림 전송 실패] 프로젝트 폴더에서 .env 파일을 찾을 수 없습니다.", file=sys.stderr)
        print(f"   • 예상 경로: {env_path}", file=sys.stderr)
        return False

    env_vars = load_env(env_path)
    access_token = env_vars.get("KAKAO_ACCESS_TOKEN")
    refresh_token = env_vars.get("KAKAO_REFRESH_TOKEN")
    rest_api_key = env_vars.get("KAKAO_REST_API_KEY")
    client_secret = env_vars.get("KAKAO_CLIENT_SECRET")

    if not access_token:
        print("\n❌ [카카오톡 알림 전송 실패] .env 파일에 'KAKAO_ACCESS_TOKEN'이 설정되어 있지 않습니다.", file=sys.stderr)
        return False

    title = top1.get("title", "농심 신라면 20개입")
    price = top1.get("price", 0)
    delivery_fee = top1.get("deliveryFee", 0)
    mall_name = top1.get("mallName", "네이버 쇼핑")
    review_count = top1.get("reviewCount", 0)
    link = top1.get("link", "https://shopping.naver.com")

    # 텍스트 메시지 본문 생성 (카카오 텍스트 템플릿 최대 200자 제한을 감안하여 상품명 적정 길이 유지)
    display_title = title if len(title) <= 50 else title[:47] + "..."
    delivery_str = " (무료배송)" if delivery_fee == 0 else f" (+배송비 {delivery_fee:,}원)"

    memo_text = (
        f"🚨 [특가 알림] 목표 가격 이하 최저가!\n\n"
        f"• 상품명: {display_title}\n"
        f"• 가격: {price:,}원{delivery_str}\n"
        f"• 쇼핑몰: {mall_name}\n"
        f"• 리뷰 수: {review_count:,}개"
    )

    template_object = {
        "object_type": "text",
        "text": memo_text,
        "link": {
            "web_url": link,
            "mobile_web_url": link
        },
        "button_title": "구매하러 가기"
    }

    url = "https://kapi.kakao.com/v2/api/talk/memo/default/send"
    post_data = urllib.parse.urlencode({
        "template_object": json.dumps(template_object, ensure_ascii=False)
    }).encode("utf-8")

    def _do_send(token):
        req = urllib.request.Request(url, data=post_data, method="POST")
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Content-Type", "application/x-www-form-urlencoded;charset=utf-8")
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, body

    # 1차 전송 시도
    try:
        status, body = _do_send(access_token)
        res_json = json.loads(body)
        if res_json.get("result_code") == 0:
            print("\n🔔 [카카오톡 알림 전송 완료]")
            print("   • 수신 대상 : 카카오톡 '나에게 보내기'")
            print(f"   • 상품명    : {display_title}")
            print(f"   • 가격      : {price:,}원{delivery_str}")
            print(f"   • 쇼핑몰    : {mall_name}")
            print(f"   • 리뷰 수   : {review_count:,}개")
            print("   • 버튼 링크 : [구매하러 가기] 연결 완료")
            return True
        else:
            print(f"\n❌ [카카오톡 알림 전송 실패] 카카오 API 응답 오류 (result_code: {res_json.get('result_code')})", file=sys.stderr)
            print(f"   • 응답 상세: {body}", file=sys.stderr)
            return False

    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")

        # 401 Unauthorized인 경우 리프레시 토큰으로 자동 갱신 시도
        if e.code == 401 and refresh_token and rest_api_key:
            print("\n🔄 카카오 액세스 토큰이 만료되어 리프레시 토큰으로 자동 갱신을 시도합니다...", file=sys.stderr)
            refreshed, new_token_or_err = refresh_kakao_token(env_path, rest_api_key, refresh_token, client_secret)
            if refreshed:
                print("   └ 토큰 갱신 성공. 메시지 전송을 재시도합니다.", file=sys.stderr)
                try:
                    status, body = _do_send(new_token_or_err)
                    res_json = json.loads(body)
                    if res_json.get("result_code") == 0:
                        print("\n🔔 [카카오톡 알림 전송 완료]")
                        print("   • 수신 대상 : 카카오톡 '나에게 보내기'")
                        print(f"   • 상품명    : {display_title}")
                        print(f"   • 가격      : {price:,}원{delivery_str}")
                        print(f"   • 쇼핑몰    : {mall_name}")
                        print(f"   • 리뷰 수   : {review_count:,}개")
                        print("   • 버튼 링크 : [구매하러 가기] 연결 완료")
                        return True
                    else:
                        print(f"\n❌ [카카오톡 알림 전송 실패] 토큰 갱신 후 재전송 실패: {body}", file=sys.stderr)
                        return False
                except Exception as retry_err:
                    print(f"\n❌ [카카오톡 알림 전송 실패] 토큰 갱신 후 재시도 중 오류: {retry_err}", file=sys.stderr)
                    return False
            else:
                print(f"❌ 카카오 토큰 자동 갱신 실패: {new_token_or_err}", file=sys.stderr)

        # 401 외 HTTP 에러 또는 갱신 실패 시 상세 안내
        print(f"\n❌ [카카오톡 알림 전송 실패] 카카오 API 오류 (HTTP {e.code})", file=sys.stderr)
        print(f"   • 응답 내용: {err_body}", file=sys.stderr)
        if e.code == 401:
            print("   • 원인: 카카오 액세스 토큰 및 리프레시 토큰이 만료되었거나 유효하지 않습니다.", file=sys.stderr)
            print("   • 조치 방법: .env 파일의 KAKAO_ACCESS_TOKEN 또는 KAKAO_REFRESH_TOKEN을 갱신해 주세요.", file=sys.stderr)
        elif e.code == 403:
            print("   • 원인: '카카오톡 메시지 전송(talk_message)' 권한이 계정에 동의되지 않았습니다.", file=sys.stderr)
            print("   • 조치 방법: 카카오 디벨로퍼스 설정에서 카카오톡 메시지 전송 동의 항목을 활성화해 주세요.", file=sys.stderr)
        elif e.code == 400:
            print("   • 원인: 카카오 메시지 템플릿 파라미터 규격이 맞지 않습니다.", file=sys.stderr)
        return False

    except urllib.error.URLError as e:
        print(f"\n❌ [카카오톡 알림 전송 실패] 카카오 서버 네트워크 연결 오류: {e.reason}", file=sys.stderr)
        print("   • 원인: 인터넷 연결 상태 또는 카카오 API 서버 접속 불가 상태입니다.", file=sys.stderr)
        return False
    except Exception as e:
        print(f"\n❌ [카카오톡 알림 전송 실패] 알 수 없는 오류 발생: {e}", file=sys.stderr)
        return False


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    js_path = os.path.join(script_dir, "percent_bot.js")

    if not os.path.exists(js_path):
        print("❌ [오류 발생] percent_bot.js 파일을 찾을 수 없습니다.", file=sys.stderr)
        sys.exit(1)

    cmd = ["node", js_path] + sys.argv[1:]

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=os.environ.copy()
        )
        stdout_text, stderr_text = proc.communicate()
    except FileNotFoundError:
        print("❌ [오류 발생] 시스템에 Node.js 런타임이 설치되어 있지 않습니다.", file=sys.stderr)
        print("   Node.js(v18 이상)를 설치하거나 경로를 확인해 주세요.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"❌ [실행 오류] {e}", file=sys.stderr)
        sys.exit(1)

    # percent_bot.js의 요약 데이터 마커 분리 및 화면 출력
    marker = "__PERCENT_BOT_SUMMARY__:"
    summary_data = None
    clean_lines = []

    for line in stdout_text.splitlines(keepends=True):
        if marker in line:
            parts = line.split(marker, 1)
            if parts[0]:
                clean_lines.append(parts[0])
            try:
                summary_data = json.loads(parts[1].strip())
            except Exception:
                pass
        else:
            clean_lines.append(line)

    # 원본 stdout 화면 출력
    if clean_lines:
        sys.stdout.write("".join(clean_lines))
        sys.stdout.flush()

    # 원본 stderr 화면 출력
    if stderr_text:
        sys.stderr.write(stderr_text)
        sys.stderr.flush()

    # percent_bot.js가 실패로 종료된 경우 (비정상 종료 코드) 알림 생략 및 그대로 종료
    if proc.returncode != 0:
        sys.exit(proc.returncode)

    # 1위 가격이 목표가 이하인지 판정하여 카카오톡 알림 전송
    if summary_data and summary_data.get("isTargetMet"):
        top1 = summary_data.get("top1")
        if top1:
            send_kakao_memo(top1, script_dir)
    else:
        # 목표가 초과일 때: 카카오톡 메시지를 보내지 않고 화면에만 출력 (요구사항 1)
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()

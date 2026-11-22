// 这个源装成的网页客户端（v.qq.com），照 App 的 TencentConstants（docs/tencent-web/API.md）。

/** Safari：播放信息按能力位答复，与 UA 无关，但能力位描述的就是 Safari。vinfo_proxy 拒绝手机 UA。 */
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
export const REFERER = 'https://v.qq.com/'
export const ORIGIN = 'https://v.qq.com'

/** 几乎所有业务调用的 tRPC 网关。 */
export const GATEWAY = 'https://pbaccess.video.qq.com'
export const VIP_HOST = 'https://vip.video.qq.com'
export const PLAY_HOST = 'https://vd6.l.qq.com'
export const DANMAKU_HOST = 'https://dm.video.qq.com'
export const SUGGEST_HOST = 'https://actapi.video.qq.com'

/** 桌面站的调用方 id（扫码登录）；手机站是 `1000006`：会话只能用自己的调用方续期（API.md §1.2）。 */
export const WEB_CALLER_APP_ID = '3000010'
export const MOBILE_CALLER_APP_ID = '1000006'

/** 历史服务的 `history_head`（前端常量）。 */
export const HISTORY_HEAD = '{"history_head": "appid=web_attent&appkey=7ed56d5d-3088-48b4-b2d2-15075bf289ef"}'
/** 搜索联想的凭据（前端常量）。 */
export const SEARCH_APP_ID = '3172'
export const SEARCH_APP_KEY = 'lGhFIPeD3HsO9xEp'

/** 播放请求和 cKey 8.5 写的 superplayer 版本。 */
export const PLAYER_VERSION = '1.74.0'
export const PLAYER_PLATFORM = '10201'

/** `vinfo_proxy`（API.md §4.1）：播放页 `__STARTUP_CONFIG__.vinfoConfig`（2026-11）。`xs` 解混淆，解不开时重读播放页。 */
export const VINFO_PLAYER_VERSION = '1.80.0'
export const VINFO_AD_VERSION = '4.4.2'
export const VINFO_PROTO_VER = '9'
export const VINFO_AD_PROTO_VER = '2026091701'
export const VINFO_SALT = 'iqbQcbYJxf1suXsyvwKDLK4y'

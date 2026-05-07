import useSWR, { SWRConfiguration } from 'swr';

// PWA cross-device 동기화 보장 — Chrome에서 변경한 데이터를 모바일에서 즉시 반영하려면
// foreground 전환·재연결 시 자동 revalidate가 필수. 이전엔 둘 다 false였고
// dedupingInterval 5분이라 모바일이 옛 SWR cache를 5분 동안 들고 있었음.
//
// 주의: SWR의 focus/reconnect revalidator도 dedupingInterval을 따른다. dedupingInterval이
// 길면 focus 갱신이 dedup으로 무력화되므로, dedupe는 짧게(2초) + focusThrottleInterval로
// focus 폭증만 별도 throttle.
const defaultConfig: SWRConfiguration = {
  revalidateOnFocus: true,         // 모바일 background→foreground 시 자동 갱신
  revalidateOnReconnect: true,     // 네트워크 복귀 시 자동 갱신
  dedupingInterval: 2000,          // 2초 — burst dedupe만, focus 갱신 trigger를 막지 않음
  focusThrottleInterval: 5000,     // 5초마다 최대 1번 focus 갱신 (탭 토글 폭증 방지)
  keepPreviousData: true,          // 깜빡임 방지 (이전 데이터 유지하면서 새로 로드)
  revalidateIfStale: true,
  errorRetryCount: 2,
  suspense: false,
};

export function useApiData<T>(key: string | null, fetcher: () => Promise<T>, config?: SWRConfiguration) {
  return useSWR<T>(key, fetcher, { ...defaultConfig, ...config });
}

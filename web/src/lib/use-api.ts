import useSWR, { SWRConfiguration } from 'swr';

const defaultConfig: SWRConfiguration = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  dedupingInterval: 300000, // 5 min
  keepPreviousData: true,
  revalidateIfStale: true,
  errorRetryCount: 2,
  suspense: false,
};

export function useApiData<T>(key: string | null, fetcher: () => Promise<T>, config?: SWRConfiguration) {
  return useSWR<T>(key, fetcher, { ...defaultConfig, ...config });
}

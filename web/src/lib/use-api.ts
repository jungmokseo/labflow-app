import useSWR, { SWRConfiguration } from 'swr';

const defaultConfig: SWRConfiguration = {
  revalidateOnFocus: false,
  dedupingInterval: 300000, // 5 min
  keepPreviousData: true,
};

export function useApiData<T>(key: string | null, fetcher: () => Promise<T>, config?: SWRConfiguration) {
  return useSWR<T>(key, fetcher, { ...defaultConfig, ...config });
}

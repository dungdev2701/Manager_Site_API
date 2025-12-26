import { URL } from 'url';

export class UrlHelper {
  /**
   * Danh sách known public suffixes (free hosting/blog platforms)
   * Các domain này thường có format: username.service.domain.tld
   */
  private static readonly PUBLIC_SUFFIXES = [
    // Japanese blog platforms
    'blog.shinobi.jp',
    'blog.fc2.com',
    'hatenablog.com',
    'hateblo.jp',
    'seesaa.net',
    'jugem.jp',
    'livedoor.blog',
    'ameblo.jp',

    // International platforms
    'github.io',
    'gitlab.io',
    'netlify.app',
    'vercel.app',
    'herokuapp.com',
    'wordpress.com',
    'blogspot.com',
    'tumblr.com',
    'wixsite.com',
    'weebly.com',
  ];

  /**
   * Extract domain từ URL đầy đủ hoặc domain
   *
   * Ví dụ:
   * - https://www.example.com/page → example.com
   * - abc.com → abc.com
   * - dungtest.blog.shinobi.jp → blog.shinobi.jp (public suffix)
   * - subdomain.example.com → example.com (private domain)
   */
  static extractDomain(urlString: string): string {
    try {
      // Thêm protocol nếu thiếu
      if (!urlString.match(/^https?:\/\//i)) {
        urlString = 'http://' + urlString;
      }

      const url = new URL(urlString);
      let hostname = url.hostname;

      // Loại bỏ www.
      hostname = hostname.replace(/^www\./i, '');

      // Extract root domain (xử lý public suffix)
      const rootDomain = this.extractRootDomain(hostname);

      return this.normalizeDomain(rootDomain);
    } catch (error) {
      throw new Error(`Invalid URL: ${urlString}`);
    }
  }

  /**
   * Extract root domain, xử lý public suffixes
   *
   * Logic:
   * 1. Check nếu hostname khớp với known public suffix
   *    → Return public suffix (vd: blog.shinobi.jp)
   * 2. Nếu không khớp → Extract domain chính (last 2 parts)
   *    → Return domain.tld (vd: example.com)
   *
   * Examples:
   * - dungtest.blog.shinobi.jp → blog.shinobi.jp
   * - abc.blog.fc2.com → blog.fc2.com
   * - subdomain.example.com → example.com
   * - example.com → example.com
   */
  private static extractRootDomain(hostname: string): string {
    // Check nếu hostname chính xác là public suffix
    if (this.PUBLIC_SUFFIXES.includes(hostname)) {
      return hostname;
    }

    // Check nếu hostname kết thúc bằng public suffix
    for (const suffix of this.PUBLIC_SUFFIXES) {
      if (hostname.endsWith('.' + suffix)) {
        // Return public suffix (bỏ subdomain cá nhân)
        return suffix;
      }
    }

    // Không phải public suffix → extract domain chính
    // Split hostname thành parts
    const parts = hostname.split('.');

    // Nếu có 2 parts hoặc ít hơn → đã là root domain
    if (parts.length <= 2) {
      return hostname;
    }

    // Lấy 2 parts cuối (domain.tld)
    // vd: sub.example.com → example.com
    return parts.slice(-2).join('.');
  }

  /**
   * Normalize domain
   */
  static normalizeDomain(domain: string): string {
    return domain.toLowerCase().trim().replace(/^www\./i, '');
  }

  /**
   * Extract domain từ URL nhưng giữ nguyên subdomain
   * Chỉ loại bỏ protocol, www, path, query string
   *
   * Ví dụ:
   * - https://www.example.com/page → example.com
   * - academy.worldrowing.com → academy.worldrowing.com
   * - 3dwarehouse.sketchup.com → 3dwarehouse.sketchup.com
   * - app.scholasticahq.com → app.scholasticahq.com
   */
  static extractDomainKeepSubdomain(urlString: string): string {
    try {
      // Trim và lowercase
      urlString = urlString.trim().toLowerCase();

      // Thêm protocol nếu thiếu
      if (!urlString.match(/^https?:\/\//i)) {
        urlString = 'http://' + urlString;
      }

      const url = new URL(urlString);
      let hostname = url.hostname;

      // Chỉ loại bỏ www.
      hostname = hostname.replace(/^www\./i, '');

      return hostname;
    } catch (error) {
      throw new Error(`Invalid URL: ${urlString}`);
    }
  }

  /**
   * Extract unique domains từ array URLs, giữ nguyên subdomain
   * Dùng cho bulk import từ Excel
   */
  static extractUniqueDomainsKeepSubdomain(urls: string[]): {
    domains: string[];
    invalid: string[];
  } {
    const domains = new Set<string>();
    const invalid: string[] = [];

    for (const url of urls) {
      try {
        const domain = this.extractDomainKeepSubdomain(url);
        domains.add(domain);
      } catch {
        invalid.push(url);
      }
    }

    return {
      domains: Array.from(domains),
      invalid,
    };
  }

  /**
   * Validate URL format
   */
  static isValidUrl(urlString: string): boolean {
    try {
      if (!urlString.match(/^https?:\/\//i)) {
        urlString = 'http://' + urlString;
      }
      new URL(urlString);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Extract unique domains từ array URLs
   * Tối ưu: Dùng Set để loại bỏ trùng lặp nhanh (O(n))
   */
  static extractUniqueDomains(urls: string[]): {
    domains: string[];
    invalid: string[];
  } {
    const domains = new Set<string>();
    const invalid: string[] = [];

    for (const url of urls) {
      try {
        const domain = this.extractDomain(url);
        domains.add(domain);
      } catch {
        invalid.push(url);
      }
    }

    return {
      domains: Array.from(domains),
      invalid,
    };
  }
}

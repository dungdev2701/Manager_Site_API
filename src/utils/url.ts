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
   * Danh sách country-code second-level domains (ccSLD)
   * Các TLD này có 2 phần: .co.jp, .com.au, .co.uk, etc.
   * Khi extract domain, cần lấy 3 parts thay vì 2
   */
  private static readonly MULTI_LEVEL_TLDS = [
    // Japan
    'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'ad.jp', 'ed.jp', 'go.jp', 'gr.jp', 'lg.jp',
    // UK
    'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'net.uk', 'sch.uk',
    // Australia
    'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
    // New Zealand
    'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'school.nz',
    // Brazil
    'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
    // India
    'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in',
    // South Korea
    'co.kr', 'ne.kr', 'or.kr', 'go.kr', 'ac.kr', 're.kr',
    // China
    'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
    // Taiwan
    'com.tw', 'net.tw', 'org.tw', 'gov.tw', 'edu.tw',
    // Hong Kong
    'com.hk', 'net.hk', 'org.hk', 'gov.hk', 'edu.hk',
    // Singapore
    'com.sg', 'net.sg', 'org.sg', 'gov.sg', 'edu.sg',
    // South Africa
    'co.za', 'net.za', 'org.za', 'gov.za', 'ac.za',
    // Other common ones
    'com.mx', 'com.ar', 'com.co', 'com.ve', 'com.pe', 'com.ec',
    'co.id', 'co.th', 'co.il', 'co.ke',
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
   * Extract root domain, xử lý public suffixes và multi-level TLDs
   *
   * Logic:
   * 1. Check nếu hostname khớp với known public suffix
   *    → Return public suffix (vd: blog.shinobi.jp)
   * 2. Check nếu hostname có multi-level TLD (.co.jp, .com.au)
   *    → Return domain + TLD (vd: rakuten.co.jp)
   * 3. Nếu không khớp → Extract domain chính (last 2 parts)
   *    → Return domain.tld (vd: example.com)
   *
   * Examples:
   * - dungtest.blog.shinobi.jp → blog.shinobi.jp
   * - abc.blog.fc2.com → blog.fc2.com
   * - plaza.rakuten.co.jp → rakuten.co.jp
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

    // Check nếu hostname có multi-level TLD (.co.jp, .com.au, etc.)
    // Cần lấy 3 parts thay vì 2
    const lastTwoParts = parts.slice(-2).join('.');
    if (this.MULTI_LEVEL_TLDS.includes(lastTwoParts)) {
      // Multi-level TLD → lấy 3 parts cuối
      // vd: plaza.rakuten.co.jp → rakuten.co.jp
      if (parts.length >= 3) {
        return parts.slice(-3).join('.');
      }
      return hostname;
    }

    // Standard TLD → lấy 2 parts cuối
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
   * Extract domain với path (dành cho GG_STACKING)
   * Giữ nguyên domain + path, chỉ loại bỏ protocol và trailing slash
   *
   * Ví dụ:
   * - docs.google.com/document → docs.google.com/document
   * - https://docs.google.com/spreadsheets → docs.google.com/spreadsheets
   * - drive.google.com/file/d/pdf → drive.google.com/file/d/pdf
   * - www.google.com/maps → google.com/maps
   */
  static extractDomainWithPath(urlString: string): string {
    try {
      // Trim
      urlString = urlString.trim();

      // Thêm protocol nếu thiếu
      if (!urlString.match(/^https?:\/\//i)) {
        urlString = 'http://' + urlString;
      }

      const url = new URL(urlString);
      let hostname = url.hostname;

      // Loại bỏ www.
      hostname = hostname.replace(/^www\./i, '');

      // Lấy pathname và loại bỏ trailing slash
      let pathname = url.pathname;
      pathname = pathname.replace(/\/+$/, ''); // Remove trailing slashes

      // Kết hợp hostname + pathname
      const result = pathname && pathname !== '/'
        ? `${hostname}${pathname}`
        : hostname;

      return result.toLowerCase();
    } catch (error) {
      throw new Error(`Invalid URL: ${urlString}`);
    }
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

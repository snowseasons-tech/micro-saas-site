-- mariadb-auto-blogger tables. Created by `blogger.py init` (CREATE TABLE IF NOT EXISTS only; never alters data).

-- One row per article. publish_at is local time in BLOG_TZ (America/Denver by default).
CREATE TABLE IF NOT EXISTS blog_posts (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  slug            VARCHAR(80) NOT NULL UNIQUE,
  title           VARCHAR(200) NOT NULL,
  description     VARCHAR(400) NOT NULL DEFAULT '',
  keywords        VARCHAR(400) NOT NULL DEFAULT '',
  author          VARCHAR(120) NOT NULL DEFAULT 'Snow Seasons Technologies',
  body            MEDIUMTEXT NOT NULL,
  status          ENUM('draft','scheduled','published','archived') NOT NULL DEFAULT 'draft',
  publish_at      DATETIME NULL,
  exported_hash   CHAR(64) NULL,
  live_checked_at DATETIME NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_status_publish (status, publish_at)
);

-- Images uploaded to the private R2 bucket. The site serves them through /blog-img/<r2_key>, which hands out
-- presigned links that expire, so the objects themselves are never public.
CREATE TABLE IF NOT EXISTS blog_images (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  post_id    INT NOT NULL,
  r2_key     VARCHAR(200) NOT NULL UNIQUE,
  alt        VARCHAR(300) NOT NULL DEFAULT '',
  mime       VARCHAR(40) NOT NULL,
  bytes      INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES blog_posts(id) ON DELETE CASCADE
);

-- Results of `blogger.py check`, newest last.
CREATE TABLE IF NOT EXISTS blog_checks (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  post_id    INT NULL,
  checked_at DATETIME NOT NULL,
  kind       ENUM('local','live') NOT NULL,
  target     VARCHAR(500) NOT NULL,
  ok         BOOLEAN NOT NULL,
  detail     VARCHAR(1000) NOT NULL DEFAULT '',
  KEY idx_checked (checked_at),
  FOREIGN KEY (post_id) REFERENCES blog_posts(id) ON DELETE SET NULL
);

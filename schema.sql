-- schema.sql (updated)
-- Replace REPLACE_WITH_DB_PASSWORD with your chosen password before running.

CREATE DATABASE IF NOT EXISTS contracts_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE contracts_db;

-- Create app DB user
CREATE USER IF NOT EXISTS 'zain'@'localhost' IDENTIFIED BY '1234';
GRANT SELECT, INSERT, UPDATE, DELETE ON contracts_db.* TO 'zain'@'localhost';
FLUSH PRIVILEGES;

-- users table
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('sales','ops_manager','general_manager','client','admin') NOT NULL DEFAULT 'sales',
  display_name VARCHAR(150),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- clients table
CREATE TABLE IF NOT EXISTS clients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  type ENUM('فرد','منشأة') NOT NULL DEFAULT 'فرد',
  city VARCHAR(100),
  district VARCHAR(100),
  contact JSON DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- services table
CREATE TABLE IF NOT EXISTS services (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- contracts table (includes new location fields stored as "lat,lng" text)
CREATE TABLE IF NOT EXISTS contracts (
  id VARCHAR(32) PRIMARY KEY, -- e.g. CN-2025-001
  client_id INT NOT NULL,
  client_type ENUM('فرد','منشأة') NOT NULL,
  service_id INT DEFAULT NULL,
  service_name VARCHAR(200) DEFAULT NULL,
  from_date DATE DEFAULT NULL,
  to_date DATE DEFAULT NULL,
  container_type VARCHAR(80) DEFAULT NULL,
  container_location VARCHAR(64) DEFAULT NULL,  -- new: موقع الحاوية (lat,lng)
  pickup_location VARCHAR(64) DEFAULT NULL,     -- new: موقع التحصيل (lat,lng)
  location VARCHAR(255) DEFAULT NULL,
  monthly_fee DECIMAL(12,2) DEFAULT 0,
  total_price DECIMAL(12,2) DEFAULT 0,
  manager VARCHAR(150) DEFAULT NULL,
  status ENUM('active','pending','expired') DEFAULT 'pending',
  sign_method ENUM('إلكتروني','يدوي') DEFAULT 'إلكتروني',
  terms TEXT,
  extra TEXT,
  pdf_url VARCHAR(512) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- Add signature fields to contracts table (for existing installations)


ALTER TABLE contracts 
MODIFY COLUMN client_id VARCHAR(255) NOT NULL;

ALTER TABLE contracts 
MODIFY COLUMN id VARCHAR(50) NOT NULL;

ALTER TABLE contracts 
ADD COLUMN file_url VARCHAR(255) NULL,
ADD COLUMN client_email VARCHAR(255) NULL;

ALTER TABLE contracts 
ADD COLUMN signature_data JSON DEFAULT NULL,
ADD COLUMN signed_at TIMESTAMP NULL DEFAULT NULL,
ADD COLUMN signed_ip VARCHAR(45) DEFAULT NULL,
ADD COLUMN signed_by VARCHAR(100) DEFAULT NULL,
ADD COLUMN file_url VARCHAR(255) NULL,
ADD COLUMN client_email VARCHAR(255) NULL;

ALTER TABLE contracts DROP FOREIGN KEY contracts_ibfk_1;

ALTER TABLE contracts MODIFY COLUMN client_id VARCHAR(255) NOT NULL;
-- First, check the referenced table and column


-- SHOW CREATE TABLE clients;

-- Then modify the referenced column to match
ALTER TABLE clients MODIFY COLUMN id VARCHAR(255) NOT NULL;


ALTER TABLE contracts 
ADD CONSTRAINT contracts_ibfk_1
FOREIGN KEY (client_id) REFERENCES clients(id);

-- DESCRIBE contracts;

ALTER TABLE contracts
ADD COLUMN city VARCHAR(100)  DEFAULT NULL,
ADD COLUMN district VARCHAR(100)  DEFAULT NULL,
ADD COLUMN duration VARCHAR(50)   DEFAULT NULL,
ADD COLUMN collector VARCHAR(150)  DEFAULT NULL;

ALTER TABLE contracts
ADD COLUMN client_phone VARCHAR(50)   DEFAULT NULL,
ADD COLUMN first_party  VARCHAR(255)  DEFAULT 'شركة بفت للمقاولات',
ADD COLUMN second_party VARCHAR(255)  DEFAULT NULL;


USE clean_service_db;

ALTER TABLE contracts ADD COLUMN  payment_type VARCHAR(50) DEFAULT 'سنوية';
ALTER TABLE contracts ADD COLUMN duration VARCHAR(50) DEFAULT 'سنوي';
ALTER TABLE contracts ADD COLUMN first_party VARCHAR(255) DEFAULT 'شركة بفت للمقاولات';
ALTER TABLE contracts ADD COLUMN second_party VARCHAR(255);
ALTER TABLE contracts ADD COLUMN client_phone VARCHAR(50);
ALTER TABLE contracts ADD COLUMN collector VARCHAR(255);
ALTER TABLE contracts ADD COLUMN container_location VARCHAR(255);
ALTER TABLE contracts ADD COLUMN pickup_location VARCHAR(255);

CREATE TABLE IF NOT EXISTS terms (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) DEFAULT 'text',
    content TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Drop the foreign key first
ALTER TABLE contracts DROP FOREIGN KEY contracts_ibfk_1;

-- Change clients.id from INT to VARCHAR to match contracts.client_id
ALTER TABLE clients MODIFY COLUMN id VARCHAR(255) PRIMARY KEY;

-- Re-add the foreign key with matching types
ALTER TABLE contracts ADD CONSTRAINT contracts_ibfk_1 
FOREIGN KEY (client_id) REFERENCES clients (id);
-- DESCRIBE clients;-- 

-- SHOW CREATE TABLE clients;-- 

ALTER TABLE contracts DROP FOREIGN KEY contracts_ibfk_1;

-- contract_attachments table
CREATE TABLE IF NOT EXISTS contract_attachments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    contract_id VARCHAR(50) NOT NULL,
    field_name VARCHAR(100) NOT NULL,
    field_type ENUM('text', 'image') NOT NULL,
    text_value TEXT,
    image_filename VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_contract_id (contract_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

GRANT ALTER, DROP, CREATE ON contracts_db.* TO 'zain'@'localhost';
FLUSH PRIVILEGES;
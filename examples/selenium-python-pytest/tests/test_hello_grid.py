from selenium.webdriver.common.by import By


def test_home_page_loads(driver, base_url):
    driver.get(base_url)
    title = driver.title
    assert title is not None
    assert title.strip() != "", f"Page title should not be blank for {base_url}"


def test_can_find_body_element(driver, base_url):
    driver.get(base_url)
    bodies = driver.find_elements(By.TAG_NAME, "body")
    assert len(bodies) == 1, "Expected exactly one <body> element"

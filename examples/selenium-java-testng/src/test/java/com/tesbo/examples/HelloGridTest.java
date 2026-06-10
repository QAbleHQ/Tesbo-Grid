package com.tesbo.examples;

import org.testng.Assert;
import org.testng.annotations.Test;

public class HelloGridTest extends BaseTest {

    @Test
    public void homePageLoads() {
        driver.get(baseUrl);
        String title = driver.getTitle();
        Assert.assertNotNull(title, "Page title should not be null");
        Assert.assertFalse(title.isBlank(), "Page title should not be blank for " + baseUrl);
    }

    @Test
    public void canFindBodyElement() {
        driver.get(baseUrl);
        long bodyCount = driver.findElements(org.openqa.selenium.By.tagName("body")).size();
        Assert.assertEquals(bodyCount, 1, "Expected exactly one <body> element");
    }
}
